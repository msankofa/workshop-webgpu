// Reviewable body-part suggestions from the facts measured by `pokemon-rig.js`.
//
// Pure: no annotation library, DOM, THREE, renderer, storage, or movement controller. The output uses
// annotation bone keys and remains a draft until the Lab explicitly applies it.

export const SUGGESTION_VERSION = 'parts-1';

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function restPoint(rig, key) {
  const m = rig.byKey.get(key)?.restWorld;
  return m ? V(m[12], m[13], m[14]) : V();
}

function descendants(rig, key, out = []) {
  out.push(key);
  for (const child of rig.byKey.get(key)?.children || []) descendants(rig, child, out);
  return out;
}

function ancestors(rig, key, include = true) {
  const out = [];
  let current = include ? key : rig.byKey.get(key)?.parent;
  while (current) {
    out.push(current);
    current = rig.byKey.get(current)?.parent ?? null;
  }
  return out;
}

function leavesBelow(rig, key) {
  const leaves = descendants(rig, key, []).filter(b => !(rig.byKey.get(b)?.children || []).length);
  return leaves.length ? leaves : [key];
}

function commonAncestor(rig, a, b) {
  const B = new Set(ancestors(rig, b));
  return ancestors(rig, a).find(key => B.has(key)) ?? rig.root;
}

function geometrySummary(rig, keys) {
  let count = 0, sum = V(), lowest = V(0, Infinity, 0);
  for (const key of keys) {
    const g = rig.geometry.get(key);
    if (!g?.count) continue;
    count += g.count;
    sum.x += g.centroid.x * g.count;
    sum.y += g.centroid.y * g.count;
    sum.z += g.centroid.z * g.count;
    if (g.lowest.y < lowest.y) lowest = g.lowest;
  }
  const fallback = restPoint(rig, keys[keys.length - 1]);
  return {
    count,
    centroid: count ? V(sum.x / count, sum.y / count, sum.z / count) : fallback,
    lowest: count ? V(lowest.x, lowest.y, lowest.z) : fallback,
  };
}

function chainSummaries(rig) {
  return rig.chains.map(chain => {
    const span = descendants(rig, chain.bones[0], []);
    return { ...chain, span, spanSet: new Set(span), ...geometrySummary(rig, span) };
  });
}

function groupSiblingFeet(candidates, height) {
  const remaining = new Set(candidates);
  const groups = [];
  for (const seed of candidates) {
    if (!remaining.has(seed)) continue;
    remaining.delete(seed);
    const group = [seed];
    // A branched foot has two distal chains with one attachment and nearly the same position. Requiring
    // proximity keeps front and rear legs separate on rigs where all four attach directly to one body bone.
    for (const other of [...remaining]) {
      if (other.attach !== seed.attach) continue;
      if (Math.sign(other.lowest.x) !== Math.sign(seed.lowest.x)) continue;
      if (distance(other.lowest, seed.lowest) > height * 0.18) continue;
      group.push(other);
      remaining.delete(other);
    }
    const count = group.reduce((n, c) => n + c.count, 0);
    const position = count
      ? V(
        group.reduce((n, c) => n + c.lowest.x * c.count, 0) / count,
        group.reduce((n, c) => n + c.lowest.y * c.count, 0) / count,
        group.reduce((n, c) => n + c.lowest.z * c.count, 0) / count,
      )
      : group[0].lowest;
    groups.push({ branches: group, attach: group[0].attach, position, count });
  }
  return groups;
}

function mirrorPairs(groups, rig, trace, findings) {
  const unused = new Set(groups);
  const pairs = [];
  const tolerance = Math.min(rig.units.halfWidth * 0.55, rig.units.height * 0.28);
  for (const group of groups) {
    if (!unused.has(group)) continue;
    let best = null, bestDistance = Infinity, runnerUp = Infinity;
    for (const other of groups) {
      if (other === group || !unused.has(other)) continue;
      if (Math.sign(other.position.x) === Math.sign(group.position.x)) continue;
      const d = Math.hypot(
        other.position.x + group.position.x,
        other.position.y - group.position.y,
        other.position.z - group.position.z,
      );
      if (d < bestDistance) { runnerUp = bestDistance; bestDistance = d; best = other; }
      else if (d < runnerUp) runnerUp = d;
    }
    const accepted = !!best && bestDistance <= tolerance;
    trace.push({
      part: 'appendages', rule: 'mirrored-foot-pair',
      candidate: group.branches.map(c => c.id),
      observed: best ? bestDistance / rig.units.height : null,
      threshold: tolerance / rig.units.height,
      runnerUp: Number.isFinite(runnerUp) ? runnerUp / rig.units.height : null,
      outcome: accepted ? 'accepted' : 'rejected',
      text: accepted
        ? `Paired opposite-side foot candidates ${(bestDistance / rig.units.height * 100).toFixed(1)}% of body height apart after mirroring.`
        : 'No opposite-side foot candidate was close enough to form a limb pair.',
    });
    unused.delete(group);
    if (accepted) {
      unused.delete(best);
      pairs.push({ groups: [group, best], mirrorDistance: bestDistance, tolerance });
    } else {
      findings.push({ severity: 'warn', code: 'unpaired-foot-candidate',
        message: 'A floor-reaching candidate has no sufficiently close opposite-side partner.' });
    }
  }
  return pairs;
}

function chainToBody(rig, group, shared) {
  if (group.branches.length === 1) {
    const branch = group.branches[0];
    const chain = [...branch.bones];
    let current = rig.byKey.get(chain[0])?.parent ?? null;
    while (current && current !== shared) {
      chain.unshift(current);
      current = rig.byKey.get(current)?.parent ?? null;
    }
    return chain;
  }
  const chain = [];
  let current = group.attach;
  while (current && current !== shared) {
    chain.unshift(current);
    current = rig.byKey.get(current)?.parent ?? null;
  }
  return chain;
}

function confidenceForPair(pair, rig) {
  const relative = pair.mirrorDistance / rig.units.height;
  const threshold = pair.tolerance / rig.units.height;
  if (relative <= threshold * 0.4) return 'strong';
  if (relative <= threshold * 0.8) return 'review';
  return 'weak';
}

/** Produce a temporary, annotation-shaped body-part draft from one measured rig. */
export function suggestPokemonParts(rig, { locomotion = null } = {}) {
  if (!rig?.bones || !rig?.byKey || !rig?.geometry || !rig?.units) {
    throw new Error('suggestPokemonParts needs a rig measured by pokemon-rig.js');
  }
  const trace = [];
  const findings = [];
  const height = rig.units.height || 1;
  const halfWidth = rig.units.halfWidth || height * 0.5;
  const summaries = chainSummaries(rig);

  const floorBand = height * 0.15;
  const offMidline = halfWidth * 0.08;
  const reachesFloor = summaries.filter(chain => chain.count > 0
    && chain.lowest.y - rig.units.floorY < floorBand
    // One lowest vertex is not the centre of a foot. Machoke's sole reaches inward near x=0 while the
    // entire foot cluster sits six units to the side; the legacy test therefore rejected both real legs.
    && Math.abs(chain.centroid.x) > offMidline);
  const distal = reachesFloor.filter(chain => !reachesFloor.some(other => other !== chain
    && chain.spanSet.has(other.bones[0])));
  for (const chain of summaries) {
    const floor = (chain.lowest.y - rig.units.floorY) / height;
    const lateral = Math.abs(chain.centroid.x) / height;
    const outcome = distal.includes(chain) ? 'accepted' : 'rejected';
    trace.push({
      part: 'contacts', rule: 'distal-floor-chain', candidate: chain.id,
      observed: { floor, lateral },
      threshold: { floor: floorBand / height, lateral: offMidline / height },
      outcome,
      text: outcome === 'accepted'
        ? `The chain reaches the lowest ${(floor * 100).toFixed(1)}% of the model and is off the centerline.`
        : 'The chain was not a distal, off-center floor candidate.',
    });
  }

  const groups = groupSiblingFeet(distal, height);
  const pairs = mirrorPairs(groups, rig, trace, findings);

  // Build provisional legs before choosing the head, because a head candidate may not contain a leg.
  const provisional = [];
  for (const pair of pairs) {
    const [a, b] = pair.groups;
    const startA = a.branches.length > 1 ? a.attach : a.branches[0].bones[0];
    const startB = b.branches.length > 1 ? b.attach : b.branches[0].bones[0];
    const shared = commonAncestor(rig, startA, startB);
    for (const group of pair.groups) {
      const chain = chainToBody(rig, group, shared);
      const branchTips = group.branches.map(branch => branch.tip);
      const contacts = [...new Set(branchTips.flatMap(tip => leavesBelow(rig, tip)))];
      if (!chain.length) {
        findings.push({ severity: 'warn', code: 'empty-suggested-leg',
          message: 'A mirrored foot pair did not produce a connected leg chain.' });
        continue;
      }
      // Side belongs to the paired foot geometry. A proximal one-bone chain may sit on the centreline
      // even when its foot is clearly lateral (Farfetch'd); asking that chain produced two C-side limbs
      // and therefore duplicate draft ids.
      const side = group.position.x > 0 ? 'L' : 'R';
      provisional.push({ group, pair, shared, chain, contacts, side });
    }
  }

  const legRoots = new Set(provisional.map(leg => leg.chain[0]));
  const carriesLeg = chain => chain.span.some(key => legRoots.has(key));
  const headCandidates = summaries
    .filter(chain => !carriesLeg(chain) && chain.count > 0)
    .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  const headWinner = headCandidates[0] ?? null;
  const headRunner = headCandidates[1] ?? null;
  const headGap = headWinner && headRunner ? headWinner.count / Math.max(1, headRunner.count) : Infinity;
  const headFraction = headWinner ? headWinner.count / Math.max(1, rig.units.totalVertices) : 0;
  // A subtree containing most of the mesh is usually the torso/root branch winning by sheer inclusion,
  // not a head. Keep it visible for review, but never call it safe enough for bulk application.
  const headConfidence = !headWinner || headFraction > 0.65 ? (headWinner ? 'weak' : 'none')
    : headGap >= 1.5 ? 'strong' : headGap >= 1.15 ? 'review' : 'weak';
  trace.push({
    part: 'head', rule: 'heaviest-non-leg-subtree', candidate: headWinner?.id ?? null,
    observed: headWinner ? { vertices: headWinner.count, meshFraction: headFraction,
      runnerUp: headRunner?.count ?? 0, ratio: headGap } : null,
    threshold: { strongRatio: 1.5, reviewRatio: 1.15, maximumSafeMeshFraction: 0.65 },
    outcome: headWinner ? 'accepted' : 'rejected',
    text: headWinner
      ? `Selected the heaviest non-leg subtree; it has ${headGap.toFixed(2)} times its runner-up's geometry.`
      : 'No non-leg subtree with geometry could suggest a head.',
  });

  const bodyCentroid = geometrySummary(rig, rig.bones.map(bone => bone.key)).centroid;
  const forward = headWinner
    ? (Math.abs(headWinner.centroid.z - bodyCentroid.z) >= Math.abs(headWinner.centroid.x - bodyCentroid.x)
      ? { axis: 'z', sign: Math.sign(headWinner.centroid.z - bodyCentroid.z) || 1 }
      : { axis: 'x', sign: Math.sign(headWinner.centroid.x - bodyCentroid.x) || 1 })
    : { axis: 'z', sign: 1 };
  const forwardOf = point => (forward.axis === 'z' ? point.z : point.x) * forward.sign;
  pairs.sort((p, q) => {
    const avg = pair => (forwardOf(pair.groups[0].position) + forwardOf(pair.groups[1].position)) / 2;
    return avg(q) - avg(p);
  });

  const appendages = [];
  const appendageConfidence = {};
  const claimed = new Set();
  pairs.forEach((pair, row) => {
    const legs = provisional.filter(leg => leg.pair === pair).sort((a, b) => a.side.localeCompare(b.side));
    const made = [];
    for (const leg of legs) {
      if (leg.chain.some(key => claimed.has(key))) {
        findings.push({ severity: 'warn', code: 'overlapping-suggested-legs',
          message: 'A proposed leg overlaps another proposed leg and was omitted.' });
        continue;
      }
      leg.chain.forEach(key => claimed.add(key));
      const id = `suggest-leg-${leg.side}-${row}`;
      const ap = { id, type: 'leg', side: leg.side, row, chain: leg.chain,
        mirror: null, author: 'suggested' };
      appendages.push(ap);
      appendageConfidence[id] = confidenceForPair(pair, rig);
      made.push(ap);
    }
    if (made.length === 2) { made[0].mirror = made[1].id; made[1].mirror = made[0].id; }
  });

  const usedLegs = new Set(appendages.map(ap => `${ap.side}:${ap.row}`));
  const contacts = [...new Set(provisional
    .filter(leg => {
      const pairRow = pairs.indexOf(leg.pair);
      return usedLegs.has(`${leg.side}:${pairRow}`);
    })
    .flatMap(leg => leg.contacts))];

  const head = headWinner ? headWinner.span.filter(key => !claimed.has(key)) : [];
  const headAttach = headWinner?.attach ?? null;
  // Root is its own authored field. Repeating it in the spine makes an apparently longer suggestion
  // without identifying another anatomical bone, and disagrees with how the Lab rows are edited.
  const spine = headAttach ? ancestors(rig, headAttach).reverse().filter(key => key !== rig.root) : [];
  const root = rig.root;
  trace.push({ part: 'root', rule: 'measured-skeleton-root', candidate: root,
    observed: root, threshold: null, outcome: root ? 'accepted' : 'rejected',
    text: root ? `The measured skeleton has one root: ${root}.` : 'The measured rig has no root.' });
  trace.push({ part: 'spine', rule: 'root-to-head-attachment', candidate: spine,
    observed: { bones: spine.length }, threshold: null, outcome: spine.length ? 'accepted' : 'rejected',
    text: spine.length ? 'Used the connected path from the skeleton root to the proposed head attachment.'
      : 'No connected root-to-head path was available.' });

  if (!appendages.length && locomotion === 'walker') {
    findings.push({ severity: 'warn', code: 'walker-without-suggested-legs',
      message: 'No sufficiently supported leg pair was found for this Walking species.' });
  }

  const confidence = {
    root: root ? 'strong' : 'none',
    spine: spine.length ? headConfidence : 'none',
    head: headConfidence,
    contacts: contacts.length ? (Object.values(appendageConfidence).includes('weak') ? 'weak' : 'review') : 'none',
    appendages: appendageConfidence,
  };
  const parts = { root, spine, head, appendages, contacts };

  return {
    version: SUGGESTION_VERSION,
    source: rig.source ?? null,
    rigHash: rig.hash ?? null,
    locomotionContext: locomotion,
    parts,
    confidence,
    trace,
    findings,
  };
}
