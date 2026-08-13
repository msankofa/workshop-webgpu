// ModelSpec: the target-agnostic thing the model studio edits, and the gates that judge it.
//
// A spec is a component tree. Each component names a primitive from the vocabulary, a material role
// and an anchor or parent component to hang from. A TARGET declares which of those exist and what
// they may cost. Nothing here knows what a bot is.
//
// The gates are the point. They are deterministic and Node-runnable, so a design can be rejected
// without a GPU, a screenshot or a person looking at it — which is what turns a generator into
// something you can trust. Four of the five live here; visibility needs the renderer.
//
// THREE is injected, never imported, so the legality and topology gates run with no renderer at
// all. Budget and penetration need real geometry, and they SKIP LOUDLY rather than silently
// passing when they cannot get it.

import { PRIMITIVE_TYPES, GEAR_LOD_SEG, triangleCount, createGeometryCache, createPrimitiveFactory } from './model-primitives.js';
import { MODIFIER_OPS } from './model-modifiers.js';
import { CSG_OPS } from './model-csg.js';

export const TOPOLOGY_CLASSES = Object.freeze([
  'continuous-sculpt',   // one flowing organic surface
  'assembled-solid',     // hard-surface parts bolted together
  'conforming-shell',    // a skin that wraps a form underneath
  'surface-relief',      // shallow detail raised from or cut into a surface
  'fiber-strand',        // a run of cable, cord, strap or hair
  'material-only',       // contributes finish, not geometry
  'open-shell',          // a surface with no enclosed volume
]);

export const LEVELS = Object.freeze(['macro', 'meso', 'micro']);

// Primitives that are hard-edged or constant-section, so a shape made of them cannot read as one
// continuous organic surface on its own.
const HARD_SURFACE = ['rbox', 'extrude', 'cylinder', 'cone', 'box'];
// Modifiers that turn a hard-surface primitive into something that CAN read as a sculpt.
const SHAPING = ['taper', 'bend', 'bulge', 'twist', 'displace'];

/**
 * Structural rules a topology class imposes on its primitive. This table is the smallest set with a
 * reason behind each entry, taken from img2threejs's flat-projection-bias rule and adapted, not
 * copied — their vocabulary has no `rbox` and ours has a modifier layer theirs does not, so the
 * sculpt rule is conditional here where theirs is a flat ban. Expect it to GROW with evidence; an
 * invented rule that rejects good designs is worse than a missing one.
 */
export function topologyConflict(component) {
  const c = component;
  const prim = c.primitive;
  if (c.topologyClass === 'material-only') {
    if (prim) return 'a material-only component contributes finish, not geometry, so it must not declare a primitive';
    return null;
  }
  if (!prim) return null;
  if (c.topologyClass === 'fiber-strand' && ['rbox', 'extrude', 'sphere', 'dome'].includes(prim)) {
    return `a fiber-strand cannot be "${prim}" — a strand is swept or revolved, and a box stack for a cable is the flat-projection failure this gate exists to catch`;
  }
  if (c.topologyClass === 'continuous-sculpt' && HARD_SURFACE.includes(prim)) {
    const shaped = (c.modifiers || []).some((m) => SHAPING.includes(m.op));
    if (!shaped) {
      return `a continuous-sculpt cannot be a bare "${prim}" — give it a shaping modifier (${SHAPING.join('/')}) or pick a curved primitive`;
    }
  }
  if (c.topologyClass === 'open-shell') {
    const open = prim === 'dome' || (prim === 'tube' && c.geometry && c.geometry.cap === false);
    if (!open) return `an open-shell must be a genuinely open surface — "dome", or "tube" with cap:false — not the closed solid "${prim}"`;
  }
  return null;
}

/** Normalises and checks a target declaration, so a broken target fails here and not per-spec. */
export function defineTarget(t) {
  const miss = ['key', 'primitives', 'roles', 'anchors'].filter((k) => !t[k]);
  if (miss.length) throw new Error(`model-spec: target is missing ${miss.join(', ')}`);
  const bad = t.primitives.filter((p) => !PRIMITIVE_TYPES.includes(p));
  if (bad.length) throw new Error(`model-spec: target "${t.key}" declares primitives the factory cannot build: ${bad.join(', ')}`);
  return {
    budget: null,
    anchorPose: null,
    // Which components get the cheap LOD twin. The bot twins rbox because that is what the batches
    // do; a target that does not render through the batches twins nothing, and saying so is the
    // difference between a real budget and a borrowed one.
    lodTwin: () => false,
    instanceFactor: () => 1,
    emit: null,
    adopt: null,
    ...t,
    primitives: Object.freeze([...t.primitives]),
    roles: Object.freeze([...t.roles]),
    anchors: Object.freeze([...t.anchors]),
  };
}

/** Spec component to the flat descriptor the primitive factory reads. */
export function descriptorFor(c) {
  return { type: c.primitive, size: c.size, ...(c.geometry || {}), modifiers: c.modifiers, csg: c.csg };
}

/**
 * How many copies of one component end up in the scene. Mirroring and repetition cost instances and
 * triangles but NOT geometries, which is exactly why authoring repetition is worth having.
 *
 * A target may multiply this again through `instanceFactor`, because some targets duplicate a piece
 * on their own: the bot's side-less anchors (`foot`, `knee`, `hip`, `elbow`…) each expand to BOTH
 * sides at build time, which is 22 of the shipped design's 87 pieces. Counting those once made the
 * budget read 87 instances where the scene draws 109.
 */
export function instanceCount(c, target = null) {
  const own = (c.mirror ? 2 : 1) * Math.max(1, (c.repeat && c.repeat.count) || 1);
  return own * (target && target.instanceFactor ? target.instanceFactor(c) : 1);
}

// ---------------------------------------------------------------------------
// Gate 1 — legality
// ---------------------------------------------------------------------------

function gateLegality(spec, target, errors) {
  const add = (code, component, message) => errors.push({ gate: 'legality', code, component, message });
  if (!spec.components || !spec.components.length) {
    add('empty', null, 'a spec must have at least one component');
    return new Map();
  }
  if (spec.target && spec.target !== target.key) {
    add('target-mismatch', null, `spec targets "${spec.target}" but was validated against "${target.key}"`);
  }
  const byId = new Map();
  for (const c of spec.components) {
    if (!c.id) { add('no-id', null, 'every component needs an id'); continue; }
    if (byId.has(c.id)) add('duplicate-id', c.id, `two components share the id "${c.id}"`);
    byId.set(c.id, c);
  }
  const anchors = new Set(target.anchors);
  for (const c of spec.components) {
    if (c.primitive && !target.primitives.includes(c.primitive)) {
      add('primitive', c.id, `"${c.primitive}" is not a primitive target "${target.key}" renders`);
    }
    if (!c.primitive && c.topologyClass !== 'material-only') {
      add('primitive', c.id, 'a component with no primitive must be topologyClass "material-only"');
    }
    if (!target.roles.includes(c.material)) {
      add('role', c.id, `"${c.material}" is not a material role target "${target.key}" has`);
    }
    if (c.topologyClass && !TOPOLOGY_CLASSES.includes(c.topologyClass)) {
      add('topology-class', c.id, `"${c.topologyClass}" is not a topology class`);
    }
    if (c.level && !LEVELS.includes(c.level)) add('level', c.id, `"${c.level}" is not a level`);
    if (!anchors.has(c.parent) && !byId.has(c.parent)) {
      add('parent', c.id, `parent "${c.parent}" is neither an anchor of "${target.key}" nor another component`);
    }
    for (const m of c.modifiers || []) {
      if (!MODIFIER_OPS.includes(m.op)) add('modifier', c.id, `"${m.op}" is not a modifier op`);
    }
    for (const e of c.csg || []) {
      if (!CSG_OPS.includes(e.op || 'subtract')) add('csg', c.id, `"${e.op}" is not a CSG op`);
      if (!e.shape || !e.shape.type) add('csg', c.id, 'a CSG entry needs a shape descriptor');
    }
  }
  // Cycles. A parent chain that loops would hang every later gate, so this runs before them.
  for (const c of spec.components) {
    const seen = new Set([c.id]);
    let cur = byId.get(c.parent);
    while (cur) {
      if (seen.has(cur.id)) { add('cycle', c.id, `parent chain from "${c.id}" loops at "${cur.id}"`); break; }
      seen.add(cur.id);
      cur = byId.get(cur.parent);
    }
  }
  return byId;
}

// ---------------------------------------------------------------------------
// Gate 2 — budget, and the geometry every later gate needs
// ---------------------------------------------------------------------------

/**
 * Builds every component's geometry and reports what the spec costs. `geometries` counts CACHE
 * ENTRIES, because each one mints an InstancedMesh bucket downstream that is never evicted;
 * `triangles` sums over instances, because that is what actually draws.
 */
export function measureSpec(spec, target, { THREE, cache = createGeometryCache() } = {}) {
  const prims = createPrimitiveFactory({ THREE, cache });
  let triangles = 0, trianglesLod = 0, instances = 0;
  const geoms = new Map();
  for (const c of spec.components || []) {
    if (!c.primitive) continue;
    const d = descriptorFor(c);
    const geo = prims.geometryFor(d);
    const n = instanceCount(c, target);
    const full = triangleCount(geo);
    let lod = full;
    if (target.lodTwin(c)) lod = triangleCount(prims.geometryFor(d, GEAR_LOD_SEG));
    triangles += full * n;
    trianglesLod += lod * n;
    instances += n;
    geoms.set(c.id, geo);
  }
  return { geometries: cache.stats().geometries, triangles, trianglesLod, instances, components: (spec.components || []).length, geoms };
}

function gateBudget(measured, target, errors) {
  const b = target.budget;
  if (!b) return;
  const add = (code, message) => errors.push({ gate: 'budget', code, component: null, message });
  if (b.geometries != null && measured.geometries > b.geometries) {
    add('geometries', `${measured.geometries} unique geometries against a budget of ${b.geometries} — each one is an instanced bucket that is never evicted`);
  }
  if (b.triangles != null && measured.triangles > b.triangles) {
    add('triangles', `${measured.triangles} triangles against a budget of ${b.triangles}`);
  }
  if (b.trianglesLod != null && measured.trianglesLod > b.trianglesLod) {
    add('triangles-lod', `${measured.trianglesLod} triangles at LOD against a budget of ${b.trianglesLod}`);
  }
}

// ---------------------------------------------------------------------------
// Gate 4 — pairwise penetration
// ---------------------------------------------------------------------------

// Walks a component up to its anchor, composing transforms. Returns the anchor it lands on and the
// world matrix relative to that anchor.
function worldMatrix(THREE, c, byId, anchorSet) {
  const m = new THREE.Matrix4();
  const acc = new THREE.Matrix4().identity();
  let cur = c, guard = 0;
  while (cur && guard++ < 256) {
    const t = cur.transform || {};
    const p = t.position || [0, 0, 0], r = t.rotation || [0, 0, 0];
    const s = t.scale == null ? [1, 1, 1] : (Array.isArray(t.scale) ? t.scale : [t.scale, t.scale, t.scale]);
    m.compose(
      new THREE.Vector3(p[0], p[1], p[2]),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(r[0], r[1], r[2])),
      new THREE.Vector3(s[0], s[1], s[2]),
    );
    acc.premultiply(m);
    if (anchorSet.has(cur.parent)) return { anchor: cur.parent, matrix: acc };
    cur = byId.get(cur.parent);
  }
  return { anchor: null, matrix: acc };
}

/**
 * Reports pairs of components that occupy the same space, and pairs that are exact duplicates.
 *
 * OVERLAP IS ADVISORY, NOT A DEFECT. This gate was designed on the assumption that one piece buried
 * inside another is an authoring failure. Run against the shipped bot design, it fired on 91 of 761
 * same-anchor pairs, and every one inspected was correct work: `gear12` is a bar on the FACE of
 * `gear0`, which is a hollow `lathe` head shell, and detail-laid-on-plate is the design language
 * throughout. An axis-aligned box is not the shape, so it cannot separate "buried" from "layered" —
 * that separation needs the real surface, which is gate 5's job and needs the renderer.
 *
 * So overlaps come back ranked, for a person to scan, and only `duplicates` are errors: same
 * geometry, same transform, same anchor is a mistake with no reading under which it is not.
 *
 * Only pieces sharing a ROOT ANCHOR are compared. Two pieces on different anchors have no known
 * relative pose unless the target supplies one, and guessing would make even the advisory list
 * noise. Parent/child pairs are skipped, because a piece attached to another is meant to overlap it.
 */
export function findPenetrations(spec, target, { THREE, geoms, byId, threshold = 0.35 } = {}) {
  const anchorSet = new Set(target.anchors);
  const boxes = [];
  for (const c of spec.components || []) {
    const geo = geoms.get(c.id);
    if (!geo) continue;
    if (!geo.boundingBox) geo.computeBoundingBox();
    const { anchor, matrix } = worldMatrix(THREE, c, byId, anchorSet);
    const box = geo.boundingBox.clone().applyMatrix4(matrix);
    // `geo` is the shared cached geometry, so identity IS descriptor equality — two pieces with the
    // same geo and the same pose are the same piece authored twice.
    boxes.push({ id: c.id, parent: c.parent, anchor, box, geo, pose: JSON.stringify(matrix.elements) });
  }
  const vol = (b) => Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
  const hits = [], duplicates = [], skipped = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      if (a.anchor !== b.anchor || a.anchor == null) { skipped.push([a.id, b.id]); continue; }
      if (a.parent === b.id || b.parent === a.id) continue;
      if (a.geo === b.geo && a.pose === b.pose) { duplicates.push({ a: a.id, b: b.id }); continue; }
      const inter = a.box.clone().intersect(b.box);
      if (inter.isEmpty()) continue;
      const share = vol(inter) / Math.max(1e-12, Math.min(vol(a.box), vol(b.box)));
      if (share > threshold) hits.push({ a: a.id, b: b.id, share });
    }
  }
  hits.sort((x, y) => y.share - x.share);
  return { hits, duplicates, unchecked: skipped.length };
}

// ---------------------------------------------------------------------------

/**
 * Runs every gate it can. Pass `{ THREE }` to get budget and penetration too; without it they are
 * listed in `skipped` rather than quietly counted as passes, because a gate that did not run and a
 * gate that passed must never look the same.
 */
export function validateSpec(spec, target, { THREE = null, penetrationThreshold = 0.35 } = {}) {
  const errors = [], warnings = [], skipped = [];
  const byId = gateLegality(spec, target, errors);

  for (const c of spec.components || []) {
    const msg = topologyConflict(c);
    if (msg) errors.push({ gate: 'topology', code: 'conflict', component: c.id, message: msg });
  }

  let measured = null, penetration = null;
  const fatal = errors.some((e) => e.gate === 'legality' && ['primitive', 'cycle', 'empty'].includes(e.code));
  if (!THREE) {
    skipped.push('budget', 'penetration');
  } else if (fatal) {
    // Building geometry for a spec that failed legality would report costs for a shape nobody can
    // render, which reads as a second, unrelated problem.
    skipped.push('budget', 'penetration');
    warnings.push({ gate: 'budget', code: 'blocked', component: null, message: 'skipped because legality failed first' });
  } else {
    measured = measureSpec(spec, target, { THREE });
    gateBudget(measured, target, errors);
    penetration = findPenetrations(spec, target, { THREE, geoms: measured.geoms, byId, threshold: penetrationThreshold });
    for (const d of penetration.duplicates) {
      errors.push({ gate: 'penetration', code: 'duplicate', component: d.a, message: `"${d.a}" and "${d.b}" are the same geometry at the same pose on the same anchor — one of them is authored twice` });
    }
    // Advisory. See findPenetrations: a box cannot tell a buried piece from a layered one, and on
    // the shipped bot design every overlap inspected was correct work.
    for (const h of penetration.hits) {
      warnings.push({ gate: 'penetration', code: 'overlap', component: h.a, message: `"${h.a}" and "${h.b}" overlap by ${(h.share * 100).toFixed(0)}% of the smaller bounding box — check it protrudes somewhere, or wait for the visibility gate` });
    }
    if (penetration.unchecked) {
      warnings.push({ gate: 'penetration', code: 'unchecked', component: null, message: `${penetration.unchecked} pairs on different anchors were not compared, because their relative pose is not in the spec` });
    }
    delete measured.geoms;
  }

  return { ok: errors.length === 0, errors, warnings, skipped, measured, penetration };
}
