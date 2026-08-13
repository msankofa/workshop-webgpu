// Creature body plans: the skeleton vocabulary, lifted out of the sim.
//
// A body plan is the whole description of a creature's frame — body box, optional head, and a list
// of legs, each with a hip attachment, a rest position on the ground and a chain of segments. It is
// what `generateBodyPlan` invents, what the IK solves against, and what the model studio's
// `creature` target reads its anchors from.
//
// This module exists because that vocabulary was tangled with 5,400 lines of steering, combat and
// foraging in `port-creature-system.js`, one of whose plan functions reaches into
// `document.getElementById`. Nothing here touches the DOM, the scene or the sim, so a plan can be
// generated and inspected in Node.
//
// WHY THE STUDIO CARES: a bot reads nine anchor names from a constant. A creature's anchor list is
// COMPUTED from its plan — leg count and segment count both vary per instance — so it is the target
// that proves the spec is not quietly assuming a fixed list. `anchorsForPlan` is that seam.
//
// THREE is injected rather than imported, because the plan's vectors are real Vector3s that the sim
// mutates in place, and because a factory keeps this file importable without a renderer.

const lerp = (a, b, t) => a + (b - a) * t;
const randRange = (rng, min, max) => min + (max - min) * rng();

// Stable, readable name for a leg: row 0 is the front pair. Rows come from finalizePlan's sort, so
// a name survives regeneration as long as the layout does.
export function legName(leg) {
  return `leg${leg.row}${leg.side < 0 ? 'L' : 'R'}`;
}

/**
 * Anchor names a spec may parent to, derived from the plan rather than declared.
 *
 * Always `body`; `head` only when the plan has one; then per leg `<name>.hip`, one `<name>.j{i}`
 * per interior joint, and `<name>.foot`. A four-legged three-segment creature has 19 anchors and a
 * sixteen-legged two-segment one has 49, which is the point.
 */
export function anchorsForPlan(plan) {
  const out = ['body'];
  if (plan.head) out.push('head');
  for (const leg of plan.legs) {
    const n = legName(leg);
    out.push(`${n}.hip`);
    for (let i = 1; i < leg.segments.length; i++) out.push(`${n}.j${i}`);
    out.push(`${n}.foot`);
  }
  return out;
}

export function createCreaturePlans({ THREE }) {
  const initA = Math.PI / 5;
  const upOut = new THREE.Vector3(0.35, -0.35, 0).normalize();
  const forward = new THREE.Vector3(0, 0, 1);

  function segment(length, dir = forward) {
    return { length, initDirection: dir.clone() };
  }

  // Builds a mirrored left/right leg pair from one side's numbers. The left copy negates x on the
  // attachment, the rest position AND each segment's initial direction, so a plan is authored once.
  function pair(attachment, rest, segments) {
    const left = {
      attachment: new THREE.Vector3(-attachment.x, attachment.y, attachment.z),
      rest: new THREE.Vector3(-rest.x, rest.y, rest.z),
      side: -1,
      row: 0,
      segments: segments.map(s => ({ length: s.length, initDirection: s.initDirection.clone() })),
    };
    const right = {
      attachment: new THREE.Vector3(attachment.x, attachment.y, attachment.z),
      rest: new THREE.Vector3(rest.x, rest.y, rest.z),
      side: 1,
      row: 0,
      segments: segments.map(s => ({ length: s.length, initDirection: new THREE.Vector3(-s.initDirection.x, s.initDirection.y, s.initDirection.z) })),
    };
    return [left, right];
  }

  // Sorts legs front-to-back and assigns row indices. Every constructor runs through this, so row
  // is always current — the gait's stepping order and the studio's anchor names both read it.
  function finalizePlan(plan) {
    plan.legs.sort((a, b) => b.rest.z - a.rest.z || a.side - b.side);
    const rows = [...new Set(plan.legs.map(l => l.rest.z))].sort((a, b) => b - a);
    for (const leg of plan.legs) leg.row = rows.indexOf(leg.rest.z);
    return plan;
  }

  const BODY_PLANS = {
    quadbot: finalizePlan({
      label: 'Quad Bot',
      bodyHeight: 1.08,
      bodyScale: new THREE.Vector3(0.62, 0.40, 0.82),
      head: true,
      legs: [
        ...pair(new THREE.Vector3(0.28, -0.24, 0.32), new THREE.Vector3(0.86, 0, 0.86), [
          segment(0.42, upOut), segment(0.46, forward), segment(0.34, forward),
        ]),
        ...pair(new THREE.Vector3(0.30, -0.24, -0.34), new THREE.Vector3(0.95, 0, -1.02), [
          segment(0.44, upOut), segment(0.50, forward), segment(0.38, forward),
        ]),
      ],
    }),
    hexbot: finalizePlan({
      label: 'Hex Bot',
      bodyHeight: 1.10,
      bodyScale: new THREE.Vector3(0.66, 0.38, 1.12),
      head: true,
      legs: [
        ...pair(new THREE.Vector3(0.28, -0.25, 0.52), new THREE.Vector3(0.92, 0, 1.22), [
          segment(0.42, upOut), segment(0.46, forward), segment(0.34, forward),
        ]),
        ...pair(new THREE.Vector3(0.32, -0.25, 0.00), new THREE.Vector3(1.08, 0, 0.02), [
          segment(0.44, upOut), segment(0.48, forward), segment(0.36, forward),
        ]),
        ...pair(new THREE.Vector3(0.30, -0.25, -0.50), new THREE.Vector3(1.00, 0, -1.28), [
          segment(0.46, upOut), segment(0.52, forward), segment(0.40, forward),
        ]),
      ],
    }),
    octobot: finalizePlan({
      label: 'Octo Bot',
      bodyHeight: 1.14,
      bodyScale: new THREE.Vector3(0.68, 0.38, 1.34),
      head: true,
      legs: [
        ...pair(new THREE.Vector3(0.28, -0.25, 0.74), new THREE.Vector3(0.92, 0, 1.52), [
          segment(0.42, upOut), segment(0.46, forward), segment(0.34, forward),
        ]),
        ...pair(new THREE.Vector3(0.33, -0.25, 0.28), new THREE.Vector3(1.10, 0, 0.62), [
          segment(0.42, upOut), segment(0.48, forward), segment(0.36, forward),
        ]),
        ...pair(new THREE.Vector3(0.33, -0.25, -0.24), new THREE.Vector3(1.10, 0, -0.62), [
          segment(0.44, upOut), segment(0.50, forward), segment(0.38, forward),
        ]),
        ...pair(new THREE.Vector3(0.28, -0.25, -0.74), new THREE.Vector3(0.98, 0, -1.56), [
          segment(0.46, upOut), segment(0.54, forward), segment(0.40, forward),
        ]),
      ],
    }),
    crawler: finalizePlan({
      label: 'Crawler',
      bodyHeight: 1.0,
      bodyScale: new THREE.Vector3(0.72, 0.44, 0.88),
      head: false,
      legs: [
        ...pair(new THREE.Vector3(0.18, -0.26, 0.18), new THREE.Vector3(0.95, 0, 0.72), [
          segment(0.50, new THREE.Vector3(Math.sin(initA), -0.42, Math.cos(initA)).normalize()),
          segment(0.56, forward),
        ]),
        ...pair(new THREE.Vector3(0.18, -0.26, -0.18), new THREE.Vector3(1.00, 0, -0.86), [
          segment(0.52, new THREE.Vector3(Math.sin(initA), -0.42, -Math.cos(initA)).normalize()),
          segment(0.60, forward),
        ]),
      ],
    }),
  };

  function clonePlan(plan) {
    return finalizePlan({
      label: plan.label,
      bodyHeight: plan.bodyHeight,
      bodyScale: plan.bodyScale.clone(),
      head: plan.head,
      legs: plan.legs.map(leg => ({
        attachment: leg.attachment.clone(),
        rest: leg.rest.clone(),
        side: leg.side,
        row: leg.row,
        segments: leg.segments.map(s => ({ length: s.length, initDirection: s.initDirection.clone() })),
      })),
    });
  }

  /**
   * Invents an arbitrary skeleton. `pairCount` and `segmentCount` are passed in rather than drawn
   * here, because the caller owns the editable min/max those come from — but they must be drawn
   * from the same `rng` FIRST, or a seed stops reproducing its creature.
   */
  function generateBodyPlan(rng, { pairCount = 2, segmentCount = 3 } = {}) {
    const bodyDepth = randRange(rng, 0.72, 1.68);
    const bodyWidth = randRange(rng, 0.48, 0.92);
    const bodyHeight = randRange(rng, 0.86, 1.35);
    const plan = {
      label: 'Generated',
      bodyHeight,
      bodyScale: new THREE.Vector3(bodyWidth, randRange(rng, 0.30, 0.58), bodyDepth),
      head: rng() > 0.18,
      legs: [],
    };

    for (let i = 0; i < pairCount; i++) {
      const t = pairCount === 1 ? 0.5 : i / (pairCount - 1);
      const z = lerp(bodyDepth * 0.82, -bodyDepth * 0.92, t);
      const restZ = z + randRange(rng, -0.45, 0.45) + (t < 0.5 ? 0.35 : -0.35);
      const hip = new THREE.Vector3(randRange(rng, 0.14, 0.36), randRange(rng, -0.38, -0.12), z * randRange(rng, 0.38, 0.62));
      const rest = new THREE.Vector3(randRange(rng, 0.78, 1.55), 0, restZ);
      const segments = [];
      for (let s = 0; s < segmentCount; s++) {
        const length = randRange(rng, 0.28, 0.62) * (s === segmentCount - 1 ? randRange(rng, 0.72, 1.2) : 1);
        const lift = s === 0 ? randRange(rng, -0.55, -0.16) : randRange(rng, -0.12, 0.16);
        segments.push(segment(length, new THREE.Vector3(randRange(rng, 0.08, 0.55), lift, z >= 0 ? 0.72 : -0.72).normalize()));
      }
      plan.legs.push(...pair(hip, rest, segments));
    }

    return finalizePlan(plan);
  }

  function serializePlan(plan) {
    if (!plan) return null;
    return {
      label: plan.label,
      bodyHeight: plan.bodyHeight,
      bodyScale: plan.bodyScale.toArray(),
      head: plan.head,
      legs: plan.legs.map(leg => ({
        attachment: leg.attachment.toArray(),
        rest: leg.rest.toArray(),
        side: leg.side,
        row: leg.row,
        segments: leg.segments.map(s => ({ length: s.length, initDirection: s.initDirection.toArray() })),
      })),
    };
  }

  function deserializePlan(data) {
    return finalizePlan({
      label: data.label || 'Generated',
      bodyHeight: data.bodyHeight,
      bodyScale: new THREE.Vector3().fromArray(data.bodyScale),
      head: data.head !== false,
      legs: data.legs.map(leg => ({
        attachment: new THREE.Vector3().fromArray(leg.attachment),
        rest: new THREE.Vector3().fromArray(leg.rest),
        side: leg.side,
        row: leg.row,
        segments: leg.segments.map(s => ({
          length: s.length,
          initDirection: new THREE.Vector3().fromArray(s.initDirection),
        })),
      })),
    });
  }

  // Applies the Model panel's scale multipliers. Mutates and returns the plan it is given, so the
  // caller clones first when the original must survive.
  function editPlanWithSettings(plan, settings) {
    plan.bodyHeight *= settings.scale * settings.bodyHeight;
    plan.bodyScale.multiplyScalar(settings.scale);
    plan.bodyScale.x *= settings.bodyWidth;
    plan.bodyScale.y *= settings.bodyThickness;
    plan.bodyScale.z *= settings.bodyDepth;
    for (const leg of plan.legs) {
      leg.attachment.multiplyScalar(settings.scale);
      leg.attachment.x *= settings.hipX;
      leg.attachment.y *= settings.hipY;
      leg.rest.multiplyScalar(settings.scale);
      leg.rest.x *= settings.restX;
      leg.rest.z *= settings.restZ;
      for (const s of leg.segments) s.length *= settings.scale * settings.segmentScale;
    }
    return finalizePlan(plan);
  }

  return {
    BODY_PLANS, segment, pair, finalizePlan, clonePlan, generateBodyPlan,
    serializePlan, deserializePlan, editPlanWithSettings,
    anchorsForPlan, legName,
  };
}
