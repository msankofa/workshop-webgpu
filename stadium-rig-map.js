// Auto-mapping an unnamed Pokemon Stadium skeleton onto a walkable body plan.
//
// THE PROBLEM. Stadium's models carry no semantic bone names — every bone is `boneNN`, numbered in
// extraction order, and nothing in the file says "left hind leg". They also carry no walk cycle: the ROM
// only ever needed idle, attacks, faint and entrance, because a Pokemon in Stadium stands on a battle
// platform and never travels. Anything that wants these models to WALK (follower Pokemon, ambient wild
// mobs) has to drive the skeleton procedurally, and to do that it first has to work out which bones are
// legs.
//
// WHAT IS ACTUALLY RELIABLE IN THESE FILES, established by reading four of them (Rattata, Growlithe,
// Ponyta, Tauros) rather than assumed:
//
//   - Skinning is RIGID: every vertex has exactly one bone at weight 1.0. So each bone owns a definite
//     lump of geometry, and "where is this bone" is a question about vertices, not about the node graph.
//     This is the single fact the whole module leans on.
//   - The rig is TWO NODES PER BONE: a `boneNN` pivot carrying rotation and translation, and a childless
//     `boneNN_scale` leaf that the skin binds to. The pivot chain is the skeleton; the leaves are where
//     the geometry hangs.
//   - Bone ORIGINS ARE NOT ANATOMICAL JOINTS. A leg's four pivots can all sit within two units of the
//     body centre while their geometry marches down to the floor eleven units away. Reading joint
//     positions off the node transforms — the obvious thing to do — produces a skeleton that looks
//     nothing like the animal. Every joint position here is therefore derived from where two bones'
//     VERTEX CLUSTERS MEET, which is the only place a real joint can be.
//   - Models stand on y = 0 and face +z, and the ROM's own idle clip keeps every foot planted within a
//     tenth of a unit. Both are checked rather than trusted: see `warnings`.
//
// The output is plain JSON — no THREE, no DOM — so `test-stadium-rig-map.mjs` can assert on it in Node,
// and `stadium-walker.js` can consume it in the browser. Heuristics fail on odd body plans by design
// (Voltorb has no legs, Diglett has no visible ones, Onix is a chain of spheres); they say so in
// `warnings` and the caller is expected to supply an override rather than get a plausible wrong answer.

import { parseGLB, nodeWorldMatrices, readSkinnedVertices, transformPoint } from './stadium-glb.js';
import { buildFootProxy } from './foot-sdf.js';

const V = (x = 0, y = 0, z = 0) => ({ x, y, z });
const sub = (a, b) => V(a.x - b.x, a.y - b.y, a.z - b.z);
const len = (a) => Math.hypot(a.x, a.y, a.z);
const dist = (a, b) => len(sub(a, b));

/** Measure the authored knee side independently of any runtime pole override. */
export function measureKneePole(hip, knee, foot) {
  const chord = sub(foot, hip);
  const kv = sub(knee, hip);
  const cl = Math.max(1e-12, chord.x ** 2 + chord.y ** 2 + chord.z ** 2);
  const d = (kv.x * chord.x + kv.y * chord.y + kv.z * chord.z) / cl;
  let pole = V(kv.x - chord.x * d, kv.y - chord.y * d, kv.z - chord.z * d);
  const distance = len(pole);
  const source = distance < 1e-6 ? 'fallback' : 'rest-geometry';
  const confidence = source === 'fallback'
    ? 0
    : Math.min(1, distance / Math.max(1e-6, Math.min(dist(hip, knee), dist(knee, foot)) * 0.1));
  if (source === 'fallback') pole = V(0, 1, 0);
  else pole = V(pole.x / distance, pole.y / distance, pole.z / distance);
  return { pole, source, confidence, distance };
}

// ===================== per-bone geometry =====================

/**
 * Group the skinned vertices by owning bone.
 *
 * Returns a Map from PIVOT node id to `{ count, centroid, min, max, lowest, points }`, where `points` is
 * the bone's vertices as a flat world-space array. Bones with no geometry (the toe-tip markers that end
 * most limb chains) are absent, which is itself a useful signal.
 */
export function boneGeometry(json, bin, ctx = nodeWorldMatrices(json)) {
  const verts = readSkinnedVertices(json, bin, ctx);
  const byLeaf = new Map();
  for (let i = 0; i < verts.count; i++) {
    const leaf = verts.joint[i];
    let g = byLeaf.get(leaf);
    if (!g) byLeaf.set(leaf, g = { count: 0, points: [], sum: V(), min: V(Infinity, Infinity, Infinity), max: V(-Infinity, -Infinity, -Infinity) });
    const x = verts.position[i * 3], y = verts.position[i * 3 + 1], z = verts.position[i * 3 + 2];
    g.count++;
    g.points.push(x, y, z);
    g.sum.x += x; g.sum.y += y; g.sum.z += z;
    g.min.x = Math.min(g.min.x, x); g.min.y = Math.min(g.min.y, y); g.min.z = Math.min(g.min.z, z);
    g.max.x = Math.max(g.max.x, x); g.max.y = Math.max(g.max.y, y); g.max.z = Math.max(g.max.z, z);
  }

  // Re-key from the `_scale` leaf the skin binds to, onto the pivot that actually moves.
  const out = new Map();
  for (const [leaf, g] of byLeaf) {
    const pivot = ctx.parent[leaf];
    let lowest = V(0, Infinity, 0);
    for (let i = 0; i < g.count; i++) {
      if (g.points[i * 3 + 1] < lowest.y) lowest = V(g.points[i * 3], g.points[i * 3 + 1], g.points[i * 3 + 2]);
    }
    out.set(pivot, {
      pivot, leaf, count: g.count, points: g.points,
      centroid: V(g.sum.x / g.count, g.sum.y / g.count, g.sum.z / g.count),
      min: g.min, max: g.max, lowest,
    });
  }
  return out;
}

/**
 * Where two bones' geometry meets — the estimate that stands in for a joint.
 *
 * Each cluster's vertices are ranked by distance to the other cluster's centroid and the nearest
 * `fraction` of them averaged; the joint is the midpoint of those two averages. Averaging a fraction
 * rather than taking the single nearest vertex is what keeps it steady on the low-poly meshes here,
 * where one stray vertex is a whole percent of a limb.
 *
 * Falls back to whichever cluster exists when the other is empty, and to the pivot's own origin when
 * neither does.
 */
export function jointBetween(a, b, fraction = 0.3) {
  if (!a && !b) return null;
  if (!a) return b.centroid;
  if (!b) return a.centroid;
  const near = (g, toward) => {
    const idx = [];
    for (let i = 0; i < g.count; i++) {
      const d = (g.points[i * 3] - toward.x) ** 2 + (g.points[i * 3 + 1] - toward.y) ** 2 + (g.points[i * 3 + 2] - toward.z) ** 2;
      idx.push([d, i]);
    }
    idx.sort((p, q) => p[0] - q[0]);
    const k = Math.max(1, Math.round(g.count * fraction));
    const out = V();
    for (let i = 0; i < k; i++) {
      const j = idx[i][1];
      out.x += g.points[j * 3]; out.y += g.points[j * 3 + 1]; out.z += g.points[j * 3 + 2];
    }
    return V(out.x / k, out.y / k, out.z / k);
  };
  const pa = near(a, b.centroid), pb = near(b, a.centroid);
  return V((pa.x + pb.x) / 2, (pa.y + pb.y) / 2, (pa.z + pb.z) / 2);
}

/** The contact patch of a foot bone: the horizontal centre of its lowest `fraction` of vertices. */
export function sole(g, floorY, fraction = 0.2) {
  // Takes one bone or several. Several matters: a foot built from a metatarsal and a toe, measured on the
  // toe alone, puts the contact point at the toe tip and the creature pivots about it.
  const parts = (Array.isArray(g) ? g : [g]).filter(p => p && p.count > 0);
  if (!parts.length) return V(0, floorY, 0);
  const ys = [];
  for (const p of parts) for (let i = 0; i < p.count; i++) ys.push([p.points[i * 3 + 1], p, i]);
  ys.sort((a, b) => a[0] - b[0]);
  const k = Math.max(1, Math.round(ys.length * fraction));
  let x = 0, z = 0;
  for (let i = 0; i < k; i++) { x += ys[i][1].points[ys[i][2] * 3]; z += ys[i][1].points[ys[i][2] * 3 + 2]; }
  return V(x / k, floorY, z / k);
}

// ===================== skeleton topology =====================

/** Pivot nodes, their pivot-only parent/child links, and the skeleton root. */
export function pivotTree(json, ctx = nodeWorldMatrices(json)) {
  const nodes = json.nodes || [];
  const isLeafScale = (i) => !(nodes[i].children || []).length;
  const pivots = new Set();
  for (const skin of json.skins || []) {
    for (const j of skin.joints) {
      const p = ctx.parent[j];
      // The bind target is the childless `_scale` leaf; its parent is the bone. A joint WITH children is
      // a one-node rig, which these files do not use — take it as its own pivot rather than guess.
      pivots.add(isLeafScale(j) && p >= 0 ? p : j);
    }
  }
  const children = new Map(), parent = new Map();
  for (const p of pivots) {
    children.set(p, []);
    let up = ctx.parent[p];
    while (up >= 0 && !pivots.has(up)) up = ctx.parent[up];
    parent.set(p, up >= 0 ? up : -1);
  }
  for (const p of pivots) {
    const up = parent.get(p);
    if (up >= 0) children.get(up).push(p);
  }
  const roots = [...pivots].filter(p => parent.get(p) === -1);
  return { pivots: [...pivots], parent, children, root: roots[0] ?? -1, roots };
}

/**
 * Split the skeleton into chains: every path from a branch point (or the root) down to a leaf.
 *
 * `chain.bones` runs from the first bone BELOW the branch to the leaf, so a chain is exactly the thing
 * that could be a limb, a tail or a neck. `chain.attach` is the branch bone it hangs off.
 */
export function extractChains(tree) {
  const chains = [];
  const isBranch = (p) => (tree.children.get(p) || []).length > 1 || tree.parent.get(p) === -1;
  for (const p of tree.pivots) {
    const up = tree.parent.get(p);
    if (up < 0 || !isBranch(up)) continue;
    const bones = [];
    let cur = p;
    while (cur >= 0) {
      bones.push(cur);
      const kids = tree.children.get(cur) || [];
      if (kids.length !== 1) break;
      cur = kids[0];
    }
    chains.push({ attach: up, bones, tip: bones[bones.length - 1], branches: (tree.children.get(bones[bones.length - 1]) || []).length > 1 });
  }
  return chains;
}

/** Every bone at or below `bone`, as a flat list. */
export function subtree(tree, bone, out = []) {
  out.push(bone);
  for (const c of tree.children.get(bone) || []) subtree(tree, c, out);
  return out;
}

// ===================== the map =====================

/**
 * Classify a Stadium skeleton into legs, spine, head and tail.
 *
 * `opts.roles` replaces the detected legs with hand-assigned ones — see `stadium-rig-roles.js`. That is
 * the fix for the species the heuristics get wrong; `opts.override` still merges over the finished map
 * for anything coarser.
 */
export function mapStadiumRig(json, bin, opts = {}) {
  const ctx = nodeWorldMatrices(json);
  const geo = boneGeometry(json, bin, ctx);
  const tree = pivotTree(json, ctx);
  const chains = extractChains(tree);
  const warnings = [];
  const name = (i) => json.nodes[i]?.name ?? `node${i}`;

  // --- extent, floor, and the units everything else is expressed in ---
  let floorY = Infinity, topY = -Infinity, spanX = 0;
  for (const g of geo.values()) {
    floorY = Math.min(floorY, g.min.y);
    topY = Math.max(topY, g.max.y);
    spanX = Math.max(spanX, Math.abs(g.min.x), Math.abs(g.max.x));
  }
  const height = topY - floorY;
  if (!(height > 0)) throw new Error('model has no vertical extent');
  if (Math.abs(floorY) > height * 0.05) warnings.push(`model does not stand on y=0 (floor at ${floorY.toFixed(2)})`);

  // --- per-chain geometry summary ---
  const chainInfo = chains.map(c => {
    let lowest = V(0, Infinity, 0), count = 0, sum = V();
    for (const b of subtree(tree, c.bones[0])) {
      const g = geo.get(b);
      if (!g) continue;
      count += g.count;
      sum.x += g.centroid.x * g.count; sum.y += g.centroid.y * g.count; sum.z += g.centroid.z * g.count;
      if (g.lowest.y < lowest.y) lowest = g.lowest;
    }
    // A chain of pure tip markers has no geometry of its own; fall back to the leaf's origin.
    if (!count) {
      const w = ctx.world[c.tip];
      lowest = V(w[12], w[13], w[14]);
    }
    const centroid = count ? V(sum.x / count, sum.y / count, sum.z / count) : lowest;
    return { ...c, lowest, centroid, count, span: subtree(tree, c.bones[0]) };
  });

  // --- legs: find the FEET first, then walk up to the hips ---
  //
  // Three rules in order, each rejecting a class of false positive the previous one lets through:
  //
  //   1. reaches the floor      — rejects the head, ears, horns, wings.
  //   2. is off the midline     — rejects the jaw, the belly and the tail, which on a low-slung animal
  //                               like Rattata all hang as low as the feet do.
  //   3. is the MOST DISTAL such chain — rejects the torso, and every bone between it and the foot. This
  //      is the rule Ponyta needed: a mane tuft hanging off the thigh makes that thigh a branch point,
  //      which cuts one leg into three separate chains, and all three "reach the floor" because the foot
  //      is somewhere below them. Only the last one is a foot.
  //
  // What survives is a foot. The leg above it is then recovered structurally rather than by more
  // heuristics: walk up from the foot until reaching a bone that is also an ancestor of the OPPOSITE leg,
  // which is the pelvis or shoulder by definition — the first place the two sides of the body meet.
  const floorBand = height * (opts.legFloorFraction ?? 0.15);
  const offMidline = spanX * (opts.midlineFraction ?? 0.08);
  const reachesFloor = chainInfo.filter(c =>
    c.count > 0 &&
    (c.lowest.y - floorY) < floorBand &&
    Math.abs(c.lowest.x) > offMidline);
  const candidates = reachesFloor.filter(c =>
    !reachesFloor.some(d => d !== c && c.span.includes(d.bones[0])));

  const used = new Set();
  const pairs = [];
  const tol = Math.min(spanX * (opts.mirrorTolerance ?? 0.35), height * 0.2);
  for (const c of candidates) {
    if (used.has(c)) continue;
    let best = null, bestD = Infinity;
    for (const d of candidates) {
      if (d === c || used.has(d)) continue;
      if (Math.sign(d.lowest.x) === Math.sign(c.lowest.x)) continue;
      // Matching bone counts only BREAK TIES. Requiring them looks right and loses real legs: Pikachu's
      // left foot hangs off its own extra bone and its right foot does not, so the two legs are four bones
      // and six, and a strict rule leaves Pikachu — the one species a follower mod certainly needs — with
      // no legs at all.
      const md = Math.hypot(d.lowest.x + c.lowest.x, d.lowest.y - c.lowest.y, d.lowest.z - c.lowest.z)
        + (d.bones.length === c.bones.length ? 0 : tol * 0.15);
      if (md < bestD) { bestD = md; best = d; }
    }
    if (best && bestD < tol) {
      used.add(c); used.add(best);
      pairs.push(c.lowest.x < 0 ? [c, best] : [best, c]);
    } else {
      warnings.push(`floor-reaching chain at ${name(c.bones[0])} has no mirror partner within ${tol.toFixed(2)}`);
    }
  }
  const legChains = new Set(pairs.flat());

  // --- head: the heaviest chain that contains no leg ---
  //
  // "Contains no leg" is the part that matters. Subtree vertex counts are dominated by the torso chain,
  // which contains everything; excluding any chain with a leg below it leaves the head, the tail and the
  // decorations, and the head is far and away the heaviest of those.
  const legRoots = new Set([...legChains].map(c => c.bones[0]));
  const carriesLeg = (c) => c.span.some(b => legRoots.has(b));
  const heaviest = chainInfo
    .filter(c => !legChains.has(c) && !carriesLeg(c) && c.count > 0)
    .sort((a, b) => b.count - a.count)[0];
  let forward = 1, forwardAxis = 'z';
  if (heaviest) {
    if (Math.abs(heaviest.centroid.z) >= Math.abs(heaviest.centroid.x)) {
      forward = Math.sign(heaviest.centroid.z) || 1;
    } else {
      forwardAxis = 'x';
      forward = Math.sign(heaviest.centroid.x) || 1;
      warnings.push('head lies along x, not z — this model does not face +z');
    }
  } else {
    warnings.push('no non-leg chain to read a facing from; assuming +z');
  }
  const fwdOf = (p) => (forwardAxis === 'z' ? p.z : p.x) * forward;
  pairs.sort((a, b) => fwdOf(b[0].lowest) - fwdOf(a[0].lowest));   // front row first

  // Walk each foot up to where the two sides of the body meet — that bone is the hip or shoulder, and
  // everything below it on this side is the leg.
  const ancestorsOf = (b) => {
    const out = [];
    let cur = tree.parent.get(b) ?? -1;
    while (cur >= 0) { out.push(cur); cur = tree.parent.get(cur) ?? -1; }
    return out;
  };
  const extendLeg = (foot, partner) => {
    const shared = new Set([...partner.bones, ...ancestorsOf(partner.bones[0])]);
    const bones = foot.bones.slice();
    let cur = tree.parent.get(bones[0]) ?? -1;
    while (cur >= 0 && !shared.has(cur)) { bones.unshift(cur); cur = tree.parent.get(cur) ?? -1; }
    return { ...foot, bones, attach: cur >= 0 ? cur : tree.root };
  };

  const legs = [];
  // A role document replaces the detected legs outright rather than merging with them. Merging needs a
  // rule for every disagreement between a guess and an instruction, and there is only one sensible rule:
  // the instruction wins. `compileRoles` in `stadium-rig-roles.js` produces these specs.
  if (opts.roles?.legs?.length) {
    for (const spec of opts.roles.legs) {
      const bones = (spec.bones || []).filter(b => geo.has(b));
      if (!bones.length) { warnings.push(`role leg ${spec.row}/${spec.side} has no bones with geometry`); continue; }
      const attach = spec.attach ?? tree.parent.get(bones[0]) ?? tree.root;
      try {
        legs.push(measureStadiumLeg({ ...spec, bones, attach, tip: bones[bones.length - 1] },
          { row: spec.row, side: spec.side, geo, tree, ctx, json, forwardAxis, forward, floorY }));
      } catch (e) {
        warnings.push(`role leg ${spec.row}/${spec.side}: ${e.message}`);
      }
    }
    if (opts.roles.warnings) warnings.push(...opts.roles.warnings);
  } else {
    pairs.forEach((pair, row) => {
      pair.forEach((c, i) => {
        const side = i === 0 ? -1 : 1;
        const full = extendLeg(c, pair[1 - i]);
        legs.push(measureStadiumLeg(full, { row, side, geo, tree, ctx, json, forwardAxis, forward, floorY }));
      });
    });
  }
  if (!legs.length) warnings.push('no legs found — this body plan cannot walk on legs');

  // --- head, tail, spine ---
  //
  // The tail is the longest REARWARD chain that carries no leg: longest first, because a tail is the one
  // thing on these models built from a long run of single-child bones, and rearward to keep a long neck
  // (Dratini, Onix) from taking the name.
  const head = heaviest ? { attach: heaviest.attach, bones: heaviest.bones, count: heaviest.count } : null;
  const tailCandidates = chainInfo
    .filter(c => c !== heaviest && !legChains.has(c) && !carriesLeg(c) && fwdOf(c.centroid) < 0)
    .sort((a, b) => (b.bones.length - a.bones.length) || (fwdOf(a.centroid) - fwdOf(b.centroid)));
  const tail = tailCandidates[0] ? { attach: tailCandidates[0].attach, bones: tailCandidates[0].bones } : null;

  // The spine is the path from the root down to the head, which is also every bone the legs hang off.
  const spine = [];
  if (head) {
    let cur = head.attach;
    while (cur >= 0) { spine.unshift(cur); cur = tree.parent.get(cur) ?? -1; }
  }

  // The body is the spine bone the legs actually attach to — where a walker should carry the creature's
  // mass. With legs on more than one spine bone, take the rearmost, which is the hip.
  const attachSet = new Set(legs.map(l => l.attach));
  // `spine` runs root-first, so the rearmost attach is the FIRST hit, not the last.
  const body = spine.find(b => attachSet.has(b))
    ?? (spine.length ? spine[spine.length - 1] : tree.root);
  const spineGeo = spine.map(b => geo.get(b)).filter(Boolean);
  const bodyCentroid = spineGeo.length
    ? (() => {
      let n = 0, s = V();
      for (const g of spineGeo) { n += g.count; s.x += g.centroid.x * g.count; s.y += g.centroid.y * g.count; s.z += g.centroid.z * g.count; }
      return V(s.x / n, s.y / n, s.z / n);
    })()
    : V(0, height * 0.5, 0);

  const map = {
    source: opts.source ?? null,
    units: { floorY, height, halfWidth: spanX },
    forward: { axis: forwardAxis, sign: forward },
    root: tree.root,
    body,
    bodyCentroid,
    // Body height above the feet, at rest — the walker's target ride height before any gait scaling.
    rideHeight: bodyCentroid.y - floorY,
    legs,
    head,
    tail,
    spine,
    names: Object.fromEntries(tree.pivots.map(p => [p, name(p)])),
    // Rest world matrices, in the glb's own space. The retarget needs them to rotate a bone about a joint
    // that is not its origin, and carrying them here means `stadium-walker.js` never has to re-read the
    // file it is animating.
    restWorld: Object.fromEntries(tree.pivots.map(p => [p, Array.from(ctx.world[p])])),
    warnings,
  };
  return opts.override ? { ...map, ...opts.override, warnings: warnings.concat(opts.override.warnings || []) } : map;
}

/**
 * One leg: its bones, the joints between them, and the two-bone abstraction the IK actually solves.
 *
 * `kneeIndex` splits the joint list into an upper and a lower rigid part. It is chosen at the halfway
 * point of the chain's arc length rather than at the first joint, because these are digitigrade animals:
 * the bend a viewer reads as "the knee" is usually the second or third joint down, and splitting at the
 * anatomical hip gives a stubby upper bone that swings the whole leg from the body.
 */
export function measureStadiumLeg(chain, { row, side, geo, tree, ctx, json, forwardAxis, forward, floorY }) {
  // `bones` is the linear joint path. `drivenBones` may additionally contain sibling toe branches; they
  // move with the lower segment but must not be mistaken for another joint in the path.
  const withGeo = chain.bones.filter(b => geo.has(b));
  if (!withGeo.length) throw new Error(`leg chain at ${json.nodes[chain.bones[0]]?.name} carries no geometry`);
  const drivenBones = [...new Set([...(chain.drivenBones || chain.bones), ...(chain.footBones || [])])]
    .filter(b => geo.has(b));
  const attachGeo = geo.get(chain.attach);

  const joints = [];
  joints.push(jointBetween(attachGeo, geo.get(withGeo[0])) ?? geo.get(withGeo[0]).centroid);
  for (let i = 1; i < withGeo.length; i++) {
    joints.push(jointBetween(geo.get(withGeo[i - 1]), geo.get(withGeo[i])));
  }
  // The tip is the SOLE: the horizontal centre of the lowest fifth of the foot's vertices, dropped to the
  // floor. Taking the single lowest vertex instead put Rattata's two front feet 1.8 units apart in x on a
  // body 11 wide — one stray vertex is a whole percent of a limb at this poly count.
  //
  // Which bones count as the foot is declared when a role document says so, and otherwise the last bone,
  // which is what this always did.
  const declaredFoot = (chain.footBones || []).filter(b => geo.has(b));
  const footBones = declaredFoot.length ? declaredFoot : [withGeo[withGeo.length - 1]];
  const solePoint = sole(footBones.map(b => geo.get(b)), floorY);
  joints.push(solePoint);

  const segLengths = [];
  for (let i = 1; i < joints.length; i++) segLengths.push(dist(joints[i - 1], joints[i]));
  const total = segLengths.reduce((s, v) => s + v, 0);

  // Split where the two halves come out most EQUAL IN A STRAIGHT LINE — not at the halfway point of the
  // chain's arc length, which is what this did first. The difference matters because a two-bone leg can
  // only reach into the annulus between |l1 - l2| and l1 + l2: split a Rattata foreleg into a 97 mm upper
  // and a 25 mm stub and its foot is locked out of everything within 59% of the leg's length from the
  // hip, which is most of where a walking foot wants to be. Equal halves make that inner hole vanish.
  let kneeIndex = 1, bestSplit = Infinity;
  for (let i = 1; i <= joints.length - 2; i++) {
    const a = dist(joints[0], joints[i]);
    const b = dist(joints[i], joints[joints.length - 1]);
    const gap = Math.abs(a - b);
    if (gap < bestSplit) { bestSplit = gap; kneeIndex = i; }
  }
  // A declared knee wins, clamped to a joint that exists so a stale role document cannot produce a leg
  // with a zero-length bone.
  if (Number.isInteger(chain.kneeIndex)) {
    kneeIndex = Math.min(Math.max(1, chain.kneeIndex), Math.max(1, joints.length - 2));
  }
  // Where the foot starts, in the same joint indexing. The walker does not split here yet; it is what an
  // ankle would rotate about.
  const ankleIndex = withGeo.indexOf(footBones[0]);

  const hip = joints[0], knee = joints[kneeIndex], foot = joints[joints.length - 1];
  const l1 = dist(hip, knee), l2 = dist(knee, foot);

  // The pole is MEASURED: the knee's own offset from the hip-to-foot chord, so an analytic solve
  // reproduces the authored bend direction instead of inventing one. Same reasoning as `bug-rig.js`.
  const measuredPole = measureKneePole(hip, knee, foot);
  const { pole } = measuredPole;
  const poleSource = measuredPole.source;
  const poleConfidence = measuredPole.confidence;

  // Fore/aft direction the leg was drawn along, in the horizontal plane — what a swing limit measures from.
  const restDir = (() => {
    const dx = foot.x - hip.x, dz = foot.z - hip.z;
    const l = Math.hypot(dx, dz);
    return l < 1e-6 ? (forwardAxis === 'z' ? V(0, 0, forward) : V(forward, 0, 0)) : V(dx / l, 0, dz / l);
  })();

  return {
    row, side,
    attach: chain.attach,
    bones: drivenBones,
    jointBones: withGeo,
    tipMarker: chain.tip !== withGeo[withGeo.length - 1] ? chain.tip : null,
    joints, segLengths, kneeIndex,
    footBones, ankleIndex,
    // The contact patch, in the foot bone's rest frame. Data only — the walker decides whether to use it.
    footProxy: buildFootProxy(footBones.map(b => geo.get(b)), {
      restWorld: ctx.world[footBones[0]],
      soleCentre: [solePoint.x, solePoint.y, solePoint.z],
      maxRadius: (l1 + l2) * 0.75,
    }),
    footFrame: footBones[0],
    l1, l2, span: total,
    hip, knee, foot, pole, poleSource, poleConfidence, restDir,
    name: json.nodes[withGeo[0]]?.name ?? String(withGeo[0]),
  };
}

/** Convenience: read a .glb and map it in one call. */
export function mapStadiumRigFromGLB(bytes, opts = {}) {
  const { json, bin } = parseGLB(bytes);
  return { json, bin, map: mapStadiumRig(json, bin, opts) };
}
