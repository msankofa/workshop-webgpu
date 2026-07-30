// Pure, THREE-free perception spine shared by bot AI and creature AI: horizontal FOV cone test,
// candidate scan (self/filter/min-range/range-cap/FOV/score) and nearest-visible selection with an
// injected line-of-sight predicate. Occlusion, spatial broad-phase and scan throttling stay
// caller-side -- they are only ever accepted as parameters here. Tests: test-perception.mjs.
//
// Replicates two existing behaviors exactly:
//   bot      -> fovDegrees 120, sightRange cap, losCheck = map raycast, nearest-first, 3D distance.
//   creature -> fovDegrees 360, no cap, no losCheck, weak-target bonus, planar (XZ) distance.

export const DEFAULT_FOV_DEGREES = 360; // full circle = no blind spot

const DEG2RAD = Math.PI / 180;

// Default accessor: a candidate may be an entity with `.pos`, or a bare {x,y?,z} point.
function defaultPositionOf(entity) {
  return entity && entity.pos ? entity.pos : entity;
}

// Squared distance; `planar` ignores y, otherwise a missing y counts as 0 (so {x,z} data is 3D-safe).
export function distanceSq(a, b, planar = false) {
  const dx = b.x - a.x, dz = b.z - a.z;
  if (planar) return dx * dx + dz * dz;
  const dy = (b.y ?? 0) - (a.y ?? 0);
  return dx * dx + dy * dy + dz * dz;
}

// Horizontal vision cone: is `toPos` within `fovDegrees` centered on `yaw` (0 = +Z)? No pitch term.
export function withinFov(fromPos, toPos, yaw, fovDegrees = DEFAULT_FOV_DEGREES) {
  const deg = fovDegrees ?? DEFAULT_FOV_DEGREES;
  if (deg >= 360) return true;
  if (yaw == null || !Number.isFinite(yaw)) return true; // no facing to test against
  const dx = toPos.x - fromPos.x, dz = toPos.z - fromPos.z;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return true; // coincident: no meaningful bearing
  const cosToTarget = (Math.sin(yaw) * dx + Math.cos(yaw) * dz) / len;
  return cosToTarget >= Math.cos(deg * DEG2RAD * 0.5);
}

// `ranges` is a single number, a named map (picked by `key`), or null/absent = uncapped.
export function resolveRange(ranges, key) {
  if (ranges == null) return Infinity;
  if (typeof ranges === 'number') return Number.isFinite(ranges) ? ranges : Infinity;
  if (key == null) return Infinity;
  const range = ranges[key];
  return typeof range === 'number' && Number.isFinite(range) ? range : Infinity;
}

function selfPosOf(self, options) {
  const positionOf = options.positionOf || defaultPositionOf;
  return options.selfPosition || positionOf(self);
}

// Snapshot so entries never alias a caller's reused scratch vector.
function snapshot(p) {
  return { x: p.x, y: p.y ?? 0, z: p.z };
}

/**
 * Cull + score candidates, cheapest gates first, sorted best (lowest score) first.
 * Returns entries {candidate, pos, distance, distanceSq, score}; stable on ties (source order wins).
 * options: {fovDegrees, ranges, rangeKey, minRange, planar, filter, scoreBonus, positionOf,
 *           selfPosition, out}
 */
export function scanCandidates(self, candidates, options = {}) {
  const {
    fovDegrees = DEFAULT_FOV_DEGREES,
    ranges = null,
    rangeKey = null,
    minRange = 0,
    planar = false,
    filter = null,
    scoreBonus = null,
    positionOf = defaultPositionOf,
  } = options;
  const out = options.out || [];
  out.length = 0;
  if (!candidates) return out;
  const from = selfPosOf(self, options);
  if (!from) return out;
  const yaw = options.yaw ?? (self ? self.yaw : undefined);
  const minRangeSq = minRange > 0 ? minRange * minRange : 0;
  for (const candidate of candidates) {
    if (candidate === self || !candidate) continue;
    if (filter && !filter(candidate)) continue;
    const to = positionOf(candidate);
    if (!to) continue;
    const dsq = distanceSq(from, to, planar);
    if (dsq < minRangeSq) continue;
    const range = resolveRange(ranges, typeof rangeKey === 'function' ? rangeKey(candidate) : rangeKey);
    if (range !== Infinity && dsq > range * range) continue;
    if (!withinFov(from, to, yaw, fovDegrees)) continue;
    const distance = Math.sqrt(dsq);
    out.push({
      candidate,
      pos: snapshot(to),
      distance,
      distanceSq: dsq,
      score: distance + (scoreBonus ? scoreBonus(candidate) : 0),
    });
  }
  out.sort((a, b) => a.score - b.score); // Array#sort is stable, so ties keep source order
  return out;
}

// Walk scored entries in order and return the first whose LOS passes; null if none do.
export function firstVisible(fromPos, entries, losCheck = null) {
  for (const entry of entries) {
    if (losCheck && !losCheck(fromPos, entry.pos, entry)) continue;
    return entry;
  }
  return null;
}

// Full routine: scan, then take the best-scoring candidate with clear line of sight. Entry form.
export function selectVisibleEntry(self, candidates, options = {}) {
  const entries = scanCandidates(self, candidates, options);
  if (!entries.length) return null;
  return firstVisible(selfPosOf(self, options), entries, options.losCheck || null);
}

// Same, returning the candidate itself (or null) -- the shape both call sites want.
export function selectNearestVisible(self, candidates, options = {}) {
  const entry = selectVisibleEntry(self, candidates, options);
  return entry ? entry.candidate : null;
}
