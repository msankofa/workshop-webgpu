// Creature locomotion: the walk cycle, lifted out of the sim.
//
// This is the part of a creature that decides where its feet go — foot-target scanning, which legs may
// step and when, the step arc, the support polygon the body balances on, and the FABRIK solve that turns
// a foot target into joint positions. It is deliberately NOT the creature: no steering, no combat, no
// foraging, no LOD, no meshes, no DOM.
//
// It exists because `demos/sdf-bug-v2` needs the walk cycle without the creature. That demo is a
// raymarched SDF, so it has no meshes to drive; what it wants is exactly this module's output, a set of
// joint positions it can upload as uniforms. Copying the math would have made a fourth hand-synced twin
// in a repo that already carries `forest-cull.js`, `light-cluster.js` and `post-grade.js` — each of
// which documents that nothing keeps it in step with the GPU code it mirrors. So the sim imports this
// rather than owning it, and there is one copy.
//
// TWO THINGS THE SIM ASSUMED THAT ARE NOW PARAMETERS, because the demo breaks both:
//
//   - `terrainHeight` is any height function. The scan only ever samples it as a scalar — a 3x3 grid of
//     calls, no raycasts and no meshes — so a closed form works as well as a heightfield. The demo's
//     ground is a sphere, `sqrt(R^2 - x^2 - z^2) - R`. Note the domain: a height function is single
//     valued per (x, z), which a sphere only is on its upper hemisphere.
//   - `footGround`, the foot's clearance above the ground, was the constant 0.06. That is six times the
//     radius of the demo bug's whole foot, which would plant it visibly in the air. It is per-solver now.
//
// SCALE IS STILL THE CALLER'S PROBLEM, and it is the part most likely to disappoint. Every gait number
// here is tuned in metres for a creature whose femur is 0.58 long; the demo bug's entire femur is about
// 0.21. Geometry scales freely, but `stepDuration`, `stepLift`, `maxSpeed` and the trigger thresholds do
// not come along, and a gait scaled in space but not in time reads as a shrunken elephant.
//
// THREE is injected rather than imported, matching `creature-plan.js`: the sim mutates real Vector3s in
// place, and a page that loads three from a CDN importmap should not also drag in a second copy from
// node_modules. The pure-scalar half of the module needs none of it and is exported directly.

// ===================== tuning =====================

/**
 * Body physics and foot placement constants, as the sim has them.
 *
 * `FOOT_GROUND` is a default only — pass `footGround` to `createLegSolver` for anything not sized like
 * the stock creatures. The rest are read by `bodySupport` and the caller's integration step.
 */
export const LOCOMOTION = {
  FOOT_GROUND: 0.06,      // foot clearance above the sampled ground
  GRAV: 10.0,
  KP: 60,                 // body-height spring
  KD: 16,                 // and its damping
  H_DRAG: 1.15,
  BOUNCE: 0.25,
  BODY_MIN_CLEAR: 0.30,   // hard floor under the body, independent of the leg spring
  ORIENT_LERP: 0.08,
  MAX_LEGS: 16,           // sizes the pooled support-polygon buffer
};

export const GAITS = {
  walk: {
    label: 'Walk',
    maxSpeed: 1.05,
    turnSpeed: 1.85,
    stationaryHeight: 1.00,
    movingHeight: 1.08,
    stationaryTrigger: { h: 0.28, v: 0.36 },
    movingTrigger: { h: 0.78, v: 0.44 },
    comfort: { h: 1.22, v: 0.78 },
    stepDuration: 0.20,
    stepLift: 0.24,
    lookAhead: 0.20,
    scanHeight: 1.75,
    scanDepth: 3.8,
    scanGrid: 0.22,
    scanHeightBias: 0.34,
    maxConcurrentFraction: 0.24,
    samePairCooldown: 0.16,
    crossPairCooldown: 0.10,
    uncomfortableSpeedMultiplier: 0.28,
    rowPairSteps: false,
    rotationLerp: 0.16,
    preferredRotationLerp: 0.14,
    preferredPitchLeeway: Math.PI / 7
  },
  gallop: {
    label: 'Gallop',
    maxSpeed: 1.65,
    turnSpeed: 1.55,
    stationaryHeight: 1.06,
    movingHeight: 1.30,
    stationaryTrigger: { h: 0.36, v: 0.44 },
    movingTrigger: { h: 1.10, v: 0.58 },
    comfort: { h: 1.55, v: 0.98 },
    stepDuration: 0.15,
    stepLift: 0.34,
    lookAhead: 0.30,
    scanHeight: 2.1,
    scanDepth: 4.4,
    scanGrid: 0.24,
    scanHeightBias: 0.46,
    maxConcurrentFraction: 0.50,
    samePairCooldown: 0.09,
    crossPairCooldown: 0.16,
    uncomfortableSpeedMultiplier: 0.58,
    rowPairSteps: true,
    rotationLerp: 0.16,
    preferredRotationLerp: 0.14,
    preferredPitchLeeway: Math.PI / 8
  }
};

/** Deep-enough clone: the nested trigger/comfort objects are what UI sliders mutate. */
export function cloneGait(gait) {
  return {
    ...gait,
    stationaryTrigger: { ...gait.stationaryTrigger },
    movingTrigger: { ...gait.movingTrigger },
    comfort: { ...gait.comfort }
  };
}

// ===================== scalar helpers =====================

export function easeInOut(t) { return t * t * (3 - 2 * t); }
export function lerp(a, b, t) { return a + (b - a) * t; }
export function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

// ===================== support polygon =====================

// Monotone chain over the grounded feet, writing into the caller's `out` so a per-frame hull costs no
// allocation. `out` holds references to the points passed in, valid only until the next call.
const _hullSort = (a, b) => a.x - b.x || a.z - b.z;
const _hullCross = (o, a, b) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
const _hullP = [], _hullLo = [], _hullUp = [];

export function convexHull(pts, count, out) {
  out.length = 0;
  if (count < 3) { for (let i = 0; i < count; i++) out.push(pts[i]); return out; }
  const p = _hullP; p.length = 0;
  for (let i = 0; i < count; i++) p.push(pts[i]);
  p.sort(_hullSort);
  const lo = _hullLo; lo.length = 0;
  for (const q of p) {
    while (lo.length >= 2 && _hullCross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop();
    lo.push(q);
  }
  const up = _hullUp; up.length = 0;
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (up.length >= 2 && _hullCross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop();
    up.push(q);
  }
  lo.pop();
  up.pop();
  for (let i = 0; i < lo.length; i++) out.push(lo[i]);
  for (let i = 0; i < up.length; i++) out.push(up[i]);
  return out;
}

export function pointInPoly(px, pz, poly) {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b.x - a.x) * (pz - a.z) - (b.z - a.z) * (px - a.x);
    if (Math.abs(c) < 1e-9) continue;
    const s = Math.sign(c);
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

export function nearestOnPoly(px, pz, poly, out) {
  let bd = Infinity;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz || 1e-9;
    let t = ((px - a.x) * dx + (pz - a.z) * dz) / L2;
    t = clamp(t, 0, 1);
    const qx = a.x + t * dx, qz = a.z + t * dz, d = (qx - px) ** 2 + (qz - pz) ** 2;
    if (d < bd) { bd = d; out.x = qx; out.z = qz; }
  }
  return out;
}

// ===================== step scheduling =====================

export function isGrounded(leg) {
  return !leg.stepping && leg.targetGrounded;
}

export function legDisplacement(leg) {
  return horizontalDistance(leg.end, leg.target);
}

export function legBy(legs, row, side) {
  return legs.find(l => l.row === row && l.side === side) || null;
}

/** Same-row mate plus the same-side neighbours one row away. */
export function adjacentPartners(legs, leg) {
  const partners = [];
  const sameRow = legBy(legs, leg.row, -leg.side);
  if (sameRow) partners.push(sameRow);
  for (const other of legs) {
    if (other === leg) continue;
    if (other.side === leg.side && Math.abs(other.row - leg.row) === 1) partners.push(other);
  }
  return partners;
}

/** Opposite-side legs in the neighbouring rows — the diagonal a walk keeps planted. */
export function diagonalPartners(legs, leg) {
  const rows = [...new Set(legs.map(l => l.row))].sort((a, b) => a - b);
  if (rows.length < 2) return [];
  const idx = rows.indexOf(leg.row);
  const candidates = [];
  const prev = rows[Math.max(0, idx - 1)];
  const next = rows[Math.min(rows.length - 1, idx + 1)];
  for (const row of new Set([prev, next])) {
    if (row !== leg.row) {
      const found = legBy(legs, row, -leg.side);
      if (found) candidates.push(found);
    }
  }
  return candidates;
}

/**
 * Cache the partner lists on each leg.
 *
 * Call once after the legs exist. These are pure functions of immutable row/side data, and they were
 * hoisted out of the per-frame path because `legs.find` inside a per-leg loop is quadratic.
 */
export function cacheLegPartners(legs) {
  for (const leg of legs) {
    leg.adjacentPartnersCached = adjacentPartners(legs, leg);
    leg.diagonalPartnersCached = diagonalPartners(legs, leg);
    leg.rowMateCached = legBy(legs, leg.row, -leg.side);
    leg.crossRowsCached = legs.filter(l => Math.abs(l.row - leg.row) === 1);
  }
  return legs;
}

export function canWalkLegMove(leg, gait, legs) {
  if (!leg.wants || leg.stepping) return false;
  if (!leg.targetGrounded) return true;

  const adjacent = leg.adjacentPartnersCached;
  if (adjacent.some(l => l.targetGrounded && !isGrounded(l))) return false;
  if (adjacent.some(l => l.targetGrounded && l.timeSinceStopMove < gait.crossPairCooldown)) return false;

  const diagonals = leg.diagonalPartnersCached;
  if (diagonals.some(l => l.targetGrounded && l.timeSinceBeginMove < gait.samePairCooldown)) return false;

  const grounded = legs.some(l => isGrounded(l));
  // A LENGTH, so it has to scale with the creature. This was the literal 0.01 (a squared 0.1 m) and that
  // is a tenth of a metre on a leg whose femur is 0.58 — reasonable there, and larger than most of the
  // demo bug's whole stride, which silently forbade the step and stranded the leg. The default reproduces
  // the old number exactly; `gait.restepEpsilon` is how anything not sized like the stock creatures says so.
  const eps = gait.restepEpsilon ?? 0.1;
  const alreadyAtTarget = leg.end.distanceToSquared(leg.target) < eps * eps;
  return grounded && !alreadyAtTarget;
}

export function canGallopLegMove(leg, gait, legs) {
  if (!leg.wants || leg.stepping) return false;
  if (!leg.targetGrounded) return true;
  if (!legs.some(l => isGrounded(l))) return false;

  const rowMate = leg.rowMateCached;
  leg.primary = leg.phase === 0 || !rowMate || !rowMate.targetGrounded;
  if (!leg.primary) {
    return rowMate?.stepping && rowMate.timeSinceBeginMove >= gait.samePairCooldown;
  }

  const crossRows = leg.crossRowsCached;
  if (crossRows.some(l => l.targetGrounded && l.timeSinceBeginMove < gait.crossPairCooldown)) return false;
  return true;
}

export function startStep(leg) {
  leg.stepping = true;
  leg.t = 0;
  leg.timeSinceBeginMove = 0;
  leg.stepStart.copy(leg.end);
  leg.stepEnd.copy(leg.target);
}

/**
 * Decide which legs begin a step this frame.
 *
 * A gallop moves a whole row at once; a walk spreads steps across phases so opposite corners are never
 * both airborne. `maxConcurrentFraction` caps how much of the body can be off the ground either way.
 */
export function scheduleSteps(legs, gait) {
  for (const leg of legs) {
    leg.canMove = gait.rowPairSteps ? canGallopLegMove(leg, gait, legs) : canWalkLegMove(leg, gait, legs);
  }

  const moving = legs.filter(l => l.stepping);
  const maxConcurrent = Math.max(1, Math.floor(legs.length * gait.maxConcurrentFraction));
  if (moving.length >= maxConcurrent) return;

  const candidates = legs
    .filter(l => l.canMove)
    .sort((a, b) => legDisplacement(b) - legDisplacement(a));

  if (!candidates.length) return;

  if (gait.rowPairSteps) {
    const row = candidates[0].row;
    const rowLegs = candidates
      .filter(l => l.row === row)
      .sort((a, b) => Number(b.primary) - Number(a.primary) || legDisplacement(b) - legDisplacement(a))
      .slice(0, maxConcurrent - moving.length);
    for (const leg of rowLegs) startStep(leg);
    return;
  }

  const activePhases = new Set(moving.map(l => l.phase));
  for (const leg of candidates) {
    if (legs.filter(l => l.stepping).length >= maxConcurrent) break;
    if (activePhases.has(leg.phase) && legs.length <= 4) continue;
    startStep(leg);
    activePhases.add(leg.phase);
  }
}

/**
 * Advance one leg by `h`: either along its step arc, or sitting still and deciding whether it wants to
 * move. `restGround` is `solveLegTarget`'s return value. `onFootfall(leg)` fires the frame a foot lands.
 */
export function advanceLeg(leg, gait, h, triggerH, triggerV, restGround, onFootfall = null) {
  const dh = horizontalDistance(leg.end, leg.target);
  const dv = Math.abs(leg.end.y - leg.target.y);
  const comfortDh = horizontalDistance(leg.end, restGround);
  const comfortDv = Math.abs(leg.end.y - restGround.y);
  leg.uncomfortable = dh > gait.comfort.h || dv > gait.comfort.v;
  if (comfortDh > gait.comfort.h || comfortDv > gait.comfort.v) leg.uncomfortable = true;

  if (leg.stepping) {
    leg.t += h / gait.stepDuration;
    const tc = Math.min(leg.t, 1), e = easeInOut(tc);
    leg.end.lerpVectors(leg.stepStart, leg.stepEnd, e);
    leg.end.y += Math.sin(Math.PI * tc) * gait.stepLift;
    if (leg.t >= 1) {
      leg.stepping = false;
      leg.end.copy(leg.stepEnd);
      leg.timeSinceStopMove = 0;
      if (onFootfall) onFootfall(leg);
    }
    leg.wants = false;
  } else {
    leg.wants = !leg.targetGrounded || dh > triggerH || dv > triggerV;
  }
  return leg;
}

// ===================== balance =====================

const _groundedBuf = Array.from({ length: LOCOMOTION.MAX_LEGS }, () => ({ x: 0, y: 0, z: 0 }));
const _hullOut = [];
const _near = { x: 0, z: 0 };
const _support = {
  fG: 0, groundedCount: 0, firstGroundedEnd: null,
  cx: 0, cy: 0, cz: 0,
  comX: 0, comY: 0, comZ: 0,
  polyY: 0, poly: _hullOut, nearX: 0, nearZ: 0,
  nx: 0, ny: 1, nz: 0, haveNormal: false,
  comInside: false, haveSupport: false,
};

/**
 * Where the body is held up from, and how hard it may push.
 *
 * The returned normal is the direction the body-height spring acts along, and it is NOT the ground
 * normal. On two or more grounded feet with the centre of mass inside the support polygon it is
 * straight up; once the COM leaves the polygon it tilts toward the nearest edge, which is what makes an
 * overreaching creature topple instead of hovering. One foot leans it from that foot to the COM.
 *
 * Returns a REUSED object, valid until the next call.
 */
export function bodySupport(legs, pos) {
  const s = _support;
  let cx = 0, cy = 0, cz = 0;
  for (const leg of legs) {
    cx += leg.end.x;
    cy += leg.end.y;
    cz += leg.end.z;
  }
  cx /= legs.length;
  cy /= legs.length;
  cz /= legs.length;
  s.cx = cx; s.cy = cy; s.cz = cz;
  s.comX = (cx + pos.x) * 0.5;
  s.comZ = (cz + pos.z) * 0.5;
  s.comY = (cy + pos.y) * 0.5 + 0.01;

  let groundedCount = 0, firstGroundedEnd = null, polyY = 0;
  for (const leg of legs) {
    if (!leg.stepping && leg.targetGrounded) {
      if (groundedCount === 0) firstGroundedEnd = leg.end;
      if (groundedCount < _groundedBuf.length) {
        const pt = _groundedBuf[groundedCount];
        pt.x = leg.end.x; pt.y = leg.end.y; pt.z = leg.end.z;
        polyY += leg.end.y;
        groundedCount++;
      }
    }
  }
  s.groundedCount = groundedCount;
  s.firstGroundedEnd = firstGroundedEnd;
  s.fG = groundedCount / legs.length;

  let nx = 0, ny = 1, nz = 0;
  s.haveNormal = groundedCount > 0;
  s.comInside = false;
  s.haveSupport = false;
  let poly = _hullOut; poly.length = 0;

  if (groundedCount === 1) {
    const g = firstGroundedEnd;
    nx = s.comX - g.x;
    ny = s.comY - g.y;
    nz = s.comZ - g.z;
  } else if (groundedCount >= 2) {
    poly = convexHull(_groundedBuf, groundedCount, _hullOut);
    polyY /= groundedCount;
    s.haveSupport = poly.length >= 3;
    s.comInside = s.haveSupport && pointInPoly(s.comX, s.comZ, poly);
    if (s.comInside) {
      nx = 0;
      ny = 1;
      nz = 0;
    } else {
      nearestOnPoly(s.comX, s.comZ, poly, _near);
      s.nearX = _near.x; s.nearZ = _near.z;
      nx = s.comX - s.nearX;
      ny = s.comY - polyY;
      nz = s.comZ - s.nearZ;
    }
  }
  s.polyY = polyY;
  s.poly = poly;

  if (s.haveNormal) {
    const L = Math.hypot(nx, ny, nz) || 1;
    nx /= L; ny /= L; nz /= L;
  }
  s.nx = nx; s.ny = ny; s.nz = nz;
  return s;
}

const _frontAvg = { x: 0, y: 0, z: 0 }, _backAvg = { x: 0, y: 0, z: 0 };
const _leftAvg = { x: 0, y: 0, z: 0 }, _rightAvg = { x: 0, y: 0, z: 0 };

/**
 * Pitch and roll from the feet: front-vs-back average height gives pitch, right-vs-left gives roll.
 *
 * Mutates `body.preferredPitch/preferredRoll` (where the terrain wants the body) and `body.pitch/roll`
 * (where it has got to), two lerps deep so a single foot dropping into a hole does not snap the body.
 * A creature missing any of the four groups is left alone rather than guessed at.
 */
export function orientFromFeet(legs, gait, body) {
  _frontAvg.x = _frontAvg.y = _frontAvg.z = 0; _backAvg.x = _backAvg.y = _backAvg.z = 0;
  _leftAvg.x = _leftAvg.y = _leftAvg.z = 0; _rightAvg.x = _rightAvg.y = _rightAvg.z = 0;
  let nF = 0, nB = 0, nL = 0, nR = 0;
  for (const leg of legs) {
    const e = leg.end;
    if (leg.restLocal.z > 0) { _frontAvg.x += e.x; _frontAvg.y += e.y; _frontAvg.z += e.z; nF++; }
    else                     { _backAvg.x  += e.x; _backAvg.y  += e.y; _backAvg.z  += e.z; nB++; }
    if (leg.side < 0)        { _leftAvg.x  += e.x; _leftAvg.y  += e.y; _leftAvg.z  += e.z; nL++; }
    else                     { _rightAvg.x += e.x; _rightAvg.y += e.y; _rightAvg.z += e.z; nR++; }
  }
  if (!nF || !nB || !nL || !nR) return false;
  if (nF > 1) { const k = 1 / nF; _frontAvg.x *= k; _frontAvg.y *= k; _frontAvg.z *= k; }
  if (nB > 1) { const k = 1 / nB; _backAvg.x  *= k; _backAvg.y  *= k; _backAvg.z  *= k; }
  if (nL > 1) { const k = 1 / nL; _leftAvg.x  *= k; _leftAvg.y  *= k; _leftAvg.z  *= k; }
  if (nR > 1) { const k = 1 / nR; _rightAvg.x *= k; _rightAvg.y *= k; _rightAvg.z *= k; }

  const fvY = _frontAvg.y - _backAvg.y;
  const fvH = Math.hypot(_frontAvg.x - _backAvg.x, _frontAvg.z - _backAvg.z) || 1e-3;
  const svY = _rightAvg.y - _leftAvg.y;
  const svH = Math.hypot(_rightAvg.x - _leftAvg.x, _rightAvg.z - _leftAvg.z) || 1e-3;

  const pitchT = -Math.atan2(fvY, fvH);
  const rollT = Math.atan2(svY, svH);

  body.preferredPitch += (pitchT - body.preferredPitch) * gait.preferredRotationLerp;
  body.preferredRoll += (rollT - body.preferredRoll) * gait.preferredRotationLerp;

  const pitchTarget = clamp(body.preferredPitch, -gait.preferredPitchLeeway, gait.preferredPitchLeeway);
  const rollTarget = clamp(body.preferredRoll, -Math.PI / 5, Math.PI / 5);
  body.pitch += (pitchTarget - body.pitch) * gait.rotationLerp;
  body.roll += (rollTarget - body.roll) * gait.rotationLerp;
  return true;
}

// ===================== THREE-dependent half =====================

// MEMOISED on the THREE instance, so two callers sharing one three get the SAME KinematicChain class.
// Without this the factory mints a fresh class per call, `instanceof` fails across callers, and "there
// is one copy of the walk cycle" would be true of the source but not of the running program.
const _byThree = new WeakMap();

/**
 * The parts that need real Vector3s: the FABRIK chain, the foot-target scan, and two vector helpers.
 *
 * `THREE` is injected so a page owning its own three instance can hand it over instead of resolving a
 * second one. Everything returned is stateless apart from module-private scratch vectors.
 */
export function createCreatureLocomotion({ THREE }) {
  if (!THREE?.Vector3) throw new Error('createCreatureLocomotion needs { THREE }');
  const cached = _byThree.get(THREE);
  if (cached) return cached;

  const _fabrikDir = new THREE.Vector3();

  /**
   * FABRIK. `solve(root, target, orientation)` walks the chain backward from the target then forward
   * from the root until the tip is within tolerance, and `points` — root first, tip last — is the joint
   * list a renderer draws between. Unreachable targets straighten the chain along root-to-target
   * instead of failing.
   */
  class KinematicChain {
    constructor(segments) {
      this.lengths = segments.map(s => s.length);
      this.totalLength = this.lengths.reduce((s, n) => s + n, 0);
      this.initDirections = segments.map(s => s.initDirection.clone());
      this.points = [];
      this.maxIterations = 12;
      this.tolerance = 0.0001;
    }

    reset(root, orientation) {
      this.points = [root.clone()];
      for (let i = 0; i < this.lengths.length; i++) {
        const dir = this.initDirections[i].clone().applyQuaternion(orientation).normalize();
        this.points.push(this.points[i].clone().addScaledVector(dir, this.lengths[i]));
      }
    }

    solve(root, target, orientation) {
      if (this.points.length !== this.lengths.length + 1) this.reset(root, orientation);

      this.points[0].copy(root);
      const total = this.totalLength;
      const distance = root.distanceTo(target);

      if (distance >= total - 1e-5) {
        _fabrikDir.subVectors(target, root).normalize();
        for (let i = 0; i < this.lengths.length; i++) {
          this.points[i + 1].copy(this.points[i]).addScaledVector(_fabrikDir, this.lengths[i]);
        }
        return this.points;
      }

      // Coincident joints have no direction to push along, so re-seed them from the rest pose.
      for (let i = 1; i < this.points.length; i++) {
        if (this.points[i].distanceToSquared(this.points[i - 1]) < 1e-8) {
          _fabrikDir.copy(this.initDirections[i - 1]).applyQuaternion(orientation).normalize();
          this.points[i].copy(this.points[i - 1]).addScaledVector(_fabrikDir, this.lengths[i - 1]);
        }
      }

      for (let iter = 0; iter < this.maxIterations; iter++) {
        this.points[this.points.length - 1].copy(target);
        for (let i = this.points.length - 2; i >= 0; i--) {
          _fabrikDir.subVectors(this.points[i], this.points[i + 1]).normalize();
          this.points[i].copy(this.points[i + 1]).addScaledVector(_fabrikDir, this.lengths[i]);
        }

        this.points[0].copy(root);
        for (let i = 0; i < this.lengths.length; i++) {
          _fabrikDir.subVectors(this.points[i + 1], this.points[i]).normalize();
          this.points[i + 1].copy(this.points[i]).addScaledVector(_fabrikDir, this.lengths[i]);
        }

        if (this.points[this.points.length - 1].distanceToSquared(target) < this.tolerance) break;
      }

      return this.points;
    }
  }

  const _tbAxis = new THREE.Vector3(), _tbUp = new THREE.Vector3();

  /**
   * Analytic two-bone IK: the knee is placed on the `pole` side by construction.
   *
   * WHY THIS EXISTS ALONGSIDE `KinematicChain`. Two segments plus a target admit a whole CIRCLE of valid
   * knee positions, and FABRIK picks one by resuming from wherever the chain already is. That is stable
   * for a standing creature and wrong for a walking one: measured on the demo bug, the knee ended up
   * below the hip-to-foot chord 63% of the time (84% on the front legs), median femur elevation -28
   * degrees against +24 as authored. The leg reads as bending the wrong way. No amount of iteration fixes
   * it, because every one of those poses satisfies the constraints FABRIK is solving.
   *
   * `pole` need not be perpendicular to the leg or normalised; only its component across the leg is used.
   * The reach is clamped into the annulus the two bones can actually span, so an unreachable target leaves
   * the leg BENT at full extension rather than snapping into a straight line.
   *
   * Returns `{ reach, used, clamped }` — the distance asked for, the distance solved for, and whether
   * those differ. Segment lengths are exact, not iterated to a tolerance.
   */
  function solveTwoBone(root, target, pole, l1, l2, outKnee, outFoot, { maxExtension = 0.999 } = {}) {
    _tbAxis.subVectors(target, root);
    let reach = _tbAxis.length();
    if (reach < 1e-6) { _tbAxis.set(0, -1, 0); reach = 1e-6; }
    else _tbAxis.multiplyScalar(1 / reach);
    const used = clamp(reach, Math.abs(l1 - l2) + 1e-5, (l1 + l2) * maxExtension);

    // Pole across the leg. A pole parallel to the leg says nothing about which way to bend, so fall back
    // to world up and then to +x — both only reachable when the leg points exactly along the fallback.
    _tbUp.copy(pole).addScaledVector(_tbAxis, -pole.dot(_tbAxis));
    if (_tbUp.lengthSq() < 1e-10) {
      _tbUp.set(0, 1, 0).addScaledVector(_tbAxis, -_tbAxis.y);
      if (_tbUp.lengthSq() < 1e-10) _tbUp.set(1, 0, 0).addScaledVector(_tbAxis, -_tbAxis.x);
    }
    _tbUp.normalize();

    const cos = clamp((used * used + l1 * l1 - l2 * l2) / (2 * used * l1), -1, 1);
    const sin = Math.sqrt(Math.max(0, 1 - cos * cos));
    outKnee.copy(root).addScaledVector(_tbAxis, l1 * cos).addScaledVector(_tbUp, l1 * sin);
    if (outFoot) outFoot.copy(root).addScaledVector(_tbAxis, used);
    return { reach, used, clamped: Math.abs(used - reach) > 1e-9 };
  }

  const _lcV = new THREE.Vector3();

  /**
   * Clamp a foot target into the envelope one leg can hold, in the frame the limits are authored in.
   *
   * All three limits are angles or ratios rather than distances, because that is what a joint has. They
   * are applied in a fixed order — swing, then rise, then reach — so a target pulled in by the reach
   * limit cannot be pushed back out by the swing limit.
   *
   *   `maxSwing`  radians the leg may rotate about the body's up axis away from `restDir`, its authored
   *               fore/aft direction. This is the one that mattered: the gait's comfort box is 0.20 m on
   *               a 0.38 m leg, which is a 180-degree azimuth sweep, and nothing else bounded it.
   *   `maxRise`   how far above the hip the foot may go, as a fraction of the leg's span.
   *   `maxReach`  fraction of the fully-extended leg the foot may reach.
   *
   * `hip`, `target` and `restDir` must all be in the SAME frame, and it must be one whose +y is the
   * body's up — body-local, not world, or the body's own pitch and roll would read as leg swing.
   * Mutates and returns `target`.
   */
  function clampLegTarget(hip, target, restDir, span, { maxSwing, maxRise, maxReach }) {
    _lcV.subVectors(target, hip);

    if (maxSwing != null) {
      const a = Math.atan2(_lcV.x, _lcV.z) - Math.atan2(restDir.x, restDir.z);
      const wrapped = Math.atan2(Math.sin(a), Math.cos(a));
      const excess = clamp(wrapped, -maxSwing, maxSwing) - wrapped;
      if (excess !== 0) {
        const c = Math.cos(excess), s = Math.sin(excess);
        const x = _lcV.x * c + _lcV.z * s;
        const z = -_lcV.x * s + _lcV.z * c;
        _lcV.x = x; _lcV.z = z;
      }
    }

    if (maxRise != null) _lcV.y = Math.min(_lcV.y, span * maxRise);

    if (maxReach != null) {
      const limit = span * maxReach;
      const len = _lcV.length();
      if (len > limit && len > 1e-9) _lcV.multiplyScalar(limit / len);
    }

    return target.copy(hip).add(_lcV);
  }

  function rotateXZ(local, yaw, out = new THREE.Vector3()) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    return out.set(
      local.x * cy + local.z * sy,
      local.y,
      -local.x * sy + local.z * cy
    );
  }

  function averageVec(points, out = new THREE.Vector3()) {
    out.set(0, 0, 0);
    if (!points.length) return out;
    for (const p of points) out.add(p);
    return out.multiplyScalar(1 / points.length);
  }

  const _bx = new THREE.Vector3(), _by = new THREE.Vector3(), _bz = new THREE.Vector3();
  const _basis = new THREE.Matrix4();
  function orientFromUpForward(up, fwd, out) {
    _by.copy(up).normalize();
    _bx.crossVectors(_by, fwd);
    if (_bx.lengthSq() < 1e-6) _bx.set(1, 0, 0);
    _bx.normalize();
    _bz.crossVectors(_bx, _by).normalize();
    _basis.makeBasis(_bx, _by, _bz);
    return out.setFromRotationMatrix(_basis);
  }

  /**
   * Bind the foot-target scan to a ground function.
   *
   * `terrainHeight(x, z)` may be anything single-valued, and `footGround` is how far above it a foot
   * rests. One solver per world; it owns scratch vectors, so do not share it across threads of control.
   */
  function createLegSolver({ terrainHeight, footGround = LOCOMOTION.FOOT_GROUND }) {
    if (typeof terrainHeight !== 'function') throw new Error('createLegSolver needs { terrainHeight }');

    const _rotated = new THREE.Vector3();
    const _restGround = new THREE.Vector3();
    const _moveDir = new THREE.Vector3();
    const _lookAhead = new THREE.Vector3();

    /**
     * Pick where `leg` should plant next, and return its rest-on-ground point (a reused scratch).
     *
     * `body` supplies `pos`, `vel` and `yaw`. The leg's rest position is carried forward along the
     * direction of travel to a look-ahead point, then a 3x3 grid around that point is scored for the
     * closest cell that is both within the scan slab and inside the gait's comfort envelope; cells
     * behind the creature are penalised so it does not step backward. Nothing found means the terrain
     * is unreachable there, and `targetGrounded` goes false — the caller's cue that this foot is
     * reaching into space.
     *
     * `fullScan: false` skips the grid and takes the look-ahead point directly, which is the cheap path
     * for distant creatures.
     */
    function solveLegTarget(leg, gait, triggerH, fullScan, body) {
      rotateXZ(leg.restLocal, body.yaw, _rotated);
      const restX = body.pos.x + _rotated.x;
      const restZ = body.pos.z + _rotated.z;
      _restGround.set(restX, terrainHeight(restX, restZ) + footGround, restZ);
      leg.restX = _restGround.x;
      leg.restY = _restGround.y;
      leg.restZ = _restGround.z;

      if (body.vel.lengthSq() > 0.0001) {
        _moveDir.copy(body.vel).setY(0).normalize();
      } else {
        _moveDir.set(Math.sin(body.yaw), 0, Math.cos(body.yaw));
      }
      _lookAhead.copy(_restGround).addScaledVector(_moveDir, triggerH * gait.lookAhead * 3.0);
      leg.lookAhead.copy(_lookAhead);
      leg.scanStart.set(_lookAhead.x, _lookAhead.y + gait.scanHeight, _lookAhead.z);
      leg.scanEnd.set(_lookAhead.x, _lookAhead.y - gait.scanDepth, _lookAhead.z);

      if (!fullScan) {
        const y = terrainHeight(_lookAhead.x, _lookAhead.z) + footGround;
        leg.target.set(_lookAhead.x, y, _lookAhead.z);
        leg.groundPosition.copy(leg.target);
        leg.targetGrounded = true;
        return _restGround;
      }

      let bestScore = Infinity, bestX = 0, bestY = 0, bestZ = 0, hasBest = false;
      const sg = gait.scanGrid;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const x = _lookAhead.x + di * sg;
          const z = _lookAhead.z + dj * sg;
          const y = terrainHeight(x, z) + footGround;
          if (y > leg.scanStart.y || y < leg.scanEnd.y) continue;

          const comfortH = Math.hypot(x - _restGround.x, z - _restGround.z);
          const comfortV = Math.abs(y - _restGround.y);
          if (comfortH > gait.comfort.h || comfortV > gait.comfort.v + 0.15) continue;

          const dlx = x - _lookAhead.x, dly = y - _lookAhead.y, dlz = z - _lookAhead.z;
          let score = dlx * dlx + dly * dly + dlz * dlz;
          const ahead = (x - _restGround.x) * _moveDir.x + (z - _restGround.z) * _moveDir.z;
          if (ahead < 0) score += Math.abs(ahead) * gait.scanHeightBias;
          if (score < bestScore) { bestScore = score; bestX = x; bestY = y; bestZ = z; hasBest = true; }
        }
      }

      if (hasBest) {
        leg.target.set(bestX, bestY, bestZ);
        leg.groundPosition.set(bestX, bestY, bestZ);
        leg.targetGrounded = true;
      } else {
        leg.target.copy(_lookAhead);
        leg.target.y = _restGround.y;
        leg.targetGrounded = false;
      }

      return _restGround;
    }

    function groundTarget(x, z, out = new THREE.Vector3()) {
      return out.set(x, terrainHeight(x, z) + footGround, z);
    }

    return { solveLegTarget, groundTarget, terrainHeight, footGround };
  }

  const api = {
    KinematicChain, solveTwoBone, clampLegTarget,
    rotateXZ, averageVec, orientFromUpForward, createLegSolver,
    // pure half, re-exported so one destructure covers the whole module
    LOCOMOTION, GAITS, cloneGait,
    easeInOut, lerp, clamp, horizontalDistance,
    convexHull, pointInPoly, nearestOnPoly,
    isGrounded, legDisplacement, legBy, adjacentPartners, diagonalPartners, cacheLegPartners,
    canWalkLegMove, canGallopLegMove, startStep, scheduleSteps, advanceLeg,
    bodySupport, orientFromFeet,
  };
  _byThree.set(THREE, api);
  return api;
}
