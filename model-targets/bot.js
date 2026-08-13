// The `bot` target: a humanoid rig whose anchors come from a constant.
//
// This is the target that proves the spec is expressive enough, because a real design already exists
// to check against. `adopt(BOT_BODY_DESIGN)` then `emit` must give back the identical 87-piece gear
// array — that round trip is the only cheap way to find out whether the schema lost anything.
//
// SCOPE: the spec covers GEAR, not the rig. `torsoProfile`, `headRadial`, `limbThicknessRatio` and
// the rest of `BOT_BODY_DESIGN`'s ~35 top-level fields describe the body the gear hangs on, and they
// pass through `adopt`/`emit` untouched in `spec.rig`. A spec is what you bolt onto a skeleton, not
// the skeleton.

import { defineTarget } from '../model-spec.js';

// Side-less names expand to BOTH sides at build time with x mirrored on the left, which is why they
// are legal anchors in their own right and not a shorthand the studio has to resolve.
export const BOT_PAIR_ANCHORS = Object.freeze(['foot', 'hand', 'knee', 'elbow', 'shoulder', 'hip']);
export const BOT_BODY_ANCHORS = Object.freeze(['pelvis', 'waist', 'torso', 'neck', 'head']);

export const BOT_ANCHORS = Object.freeze([
  ...BOT_BODY_ANCHORS,
  ...BOT_PAIR_ANCHORS,
  ...BOT_PAIR_ANCHORS.flatMap((n) => [n + 'L', n + 'R']),
]);

export const BOT_ROLES = Object.freeze(['metal', 'rubber', 'plate', 'fabric', 'shell', 'eye', 'accent', 'visor']);

// Fields a gear descriptor carries that are NOT geometry. Everything else on a descriptor is read
// by the primitive factory, so it belongs in the component's `geometry` bag — including fields this
// list has never heard of, which is what keeps `adopt` lossless as the vocabulary grows.
const STRUCTURAL = ['anchor', 'type', 'role', 'size', 'position', 'rotation', 'scale', 'id', 'faceBody', 'modifiers', 'csg'];

/** One gear descriptor to one spec component. */
export function adoptGear(g, index) {
  const geometry = {};
  for (const k of Object.keys(g)) if (!STRUCTURAL.includes(k)) geometry[k] = g[k];
  const transform = {};
  if (g.position) transform.position = g.position;
  if (g.rotation) transform.rotation = g.rotation;
  if (g.scale != null) transform.scale = g.scale;
  const c = {
    id: g.id != null ? String(g.id) : `gear${index}`,
    parent: g.anchor || 'torso',
    primitive: g.type,
    material: g.role,
    transform,
  };
  if (g.size) c.size = g.size;
  if (Object.keys(geometry).length) c.geometry = geometry;
  if (g.modifiers) c.modifiers = g.modifiers;
  if (g.csg) c.csg = g.csg;
  // `faceBody` puts the piece on a second anchor whose roll is locked to the body's forward. It is a
  // rig behaviour, not a shape, so it rides in flags rather than becoming schema vocabulary.
  if (g.faceBody) c.flags = { faceBody: true };
  // Ids only survive the round trip if the design authored them. Synthesised ones are dropped on
  // emit, or every adopt would silently add 87 new fields to the shipped design.
  c._synthId = g.id == null;
  return c;
}

/** One spec component back to a gear descriptor, in the field order the design file uses. */
export function emitGear(c) {
  const g = {};
  if (!c._synthId && c.id != null) g.id = c.id;
  g.anchor = c.parent;
  g.type = c.primitive;
  g.role = c.material;
  if (c.flags && c.flags.faceBody) g.faceBody = true;
  for (const [k, v] of Object.entries(c.geometry || {})) g[k] = v;
  const t = c.transform || {};
  if (t.position) g.position = t.position;
  if (c.size) g.size = c.size;
  if (t.rotation) g.rotation = t.rotation;
  if (t.scale != null) g.scale = t.scale;
  if (c.modifiers) g.modifiers = c.modifiers;
  if (c.csg) g.csg = c.csg;
  return g;
}

export const botTarget = defineTarget({
  key: 'bot',
  // No `tube` yet: the rig hangs gear off joint frames, and a swept run between two joints needs a
  // path that moves with the pose. That is a target feature, not a vocabulary one.
  primitives: ['rbox', 'dome', 'lathe', 'extrude', 'sphere', 'cylinder', 'capsule', 'torus', 'cone'],
  roles: BOT_ROLES,
  anchors: BOT_ANCHORS,
  // Sized from the shipped design, which mints 120 geometries in the game and is the thing every
  // bot in a 90-bot scene pays for. Headroom, not a target to fill.
  budget: { geometries: 160, triangles: 90000 },
  // Only rbox gets a cheap twin, matching what the batches actually do.
  lodTwin: (c) => c.primitive === 'rbox',
  // A side-less anchor draws the piece on BOTH sides, so it costs two instances for one geometry.
  instanceFactor: (c) => (BOT_PAIR_ANCHORS.includes(c.parent) ? 2 : 1),

  /** `BOT_BODY_DESIGN` (or any design of that shape) to a ModelSpec. */
  adopt(design) {
    const { gear = [], ...rig } = design || {};
    return {
      id: design && design.id ? design.id : 'bot-design',
      name: design && design.name ? design.name : 'Bot',
      target: 'bot',
      rig,
      components: gear.map(adoptGear),
    };
  },

  /** A ModelSpec back to a design object: the rig fields it came in with, plus a gear array. */
  emit(spec) {
    return { ...(spec.rig || {}), gear: (spec.components || []).map(emitGear) };
  },
});

export default botTarget;
