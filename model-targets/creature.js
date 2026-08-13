// The `creature` target: the same descriptor model as `bot`, with anchors DERIVED from a body plan.
//
// This target exists early on purpose. A bot reads nine anchor names from a constant, so validating
// against it can never prove the spec is free of a fixed-anchor assumption. A creature's anchor list
// is computed per instance — leg count and segment count both vary — so a spec that survives here is
// one the seam actually holds for.
//
// The skeleton was never the hard part: `generateBodyPlan` has invented arbitrary rigs for a long
// time, and `creature-plan.js` is that vocabulary lifted out of the sim. What a creature needs from
// Stage 1b is the SURFACE — limbs are uniform boxes and capsules today, and taper and bulge are what
// make a limb read as a limb rather than a tube.

import { defineTarget } from '../model-spec.js';
import { anchorsForPlan } from '../creature-plan.js';

export const CREATURE_ROLES = Object.freeze(['shell', 'plate', 'trim', 'light', 'eye', 'accent']);

/**
 * Builds the target for one body plan. `plan` is anything `creature-plan.js` produces — a stock
 * skeleton, a generated one, or a deserialised one.
 */
export function createCreatureTarget(plan, overrides = {}) {
  return defineTarget({
    key: 'creature',
    // The full vocabulary, unlike the bot: `tube` is how a tail, a tendon or a vine gets made, and
    // a creature's anchors sit on a chain the sweep can follow.
    primitives: ['rbox', 'dome', 'lathe', 'extrude', 'sphere', 'cylinder', 'capsule', 'torus', 'cone', 'tube'],
    roles: CREATURE_ROLES,
    anchors: anchorsForPlan(plan),
    // Deliberately NOT the bot's budget. Creature segments render as individual scene meshes rather
    // than through `body-part-batches.js`, so unique-geometry count does not buy an instanced bucket
    // here and the economics are a different shape. Assuming the bot's numbers would be borrowing a
    // cost model that does not apply.
    budget: { geometries: 60, triangles: 40000 },
    lodTwin: () => false,
    plan,
    ...overrides,
  });
}

export default createCreatureTarget;
