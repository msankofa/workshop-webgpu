// bot-cover.js — pure, THREE-free cover-corner query + peek-cycle timing/slide math.
// Node-tested in test-bot-cover.mjs; consumed by bot-viewer.html's cover FSM wiring.
// A peek cycle: concealed at anchorPos (jittered hold so squads don't metronome) -> slide out
// along the baked anchor->peek line -> fully exposed at peekPos (fixed hold, aim/fire window)
// -> slide back. Positions are driven, not steered: the holder re-seats onto the line each frame.

import { cellIndexAt } from './nav-visibility.js';

export const PEEK_OUT_S = 1.2;        // s fully exposed at peekPos per cycle
export const PEEK_IN_MIN_S = 0.8;     // concealed-hold jitter range, re-rolled each cycle
export const PEEK_IN_MAX_S = 1.6;
export const PEEK_SLIDE_S = 0.15;     // s for the anchor<->peek slide
export const PEEK_APPROACH_SPEED = 8; // m/s cap when seating onto / tracking the slide line

export function rollPeekIn(rand = Math.random) {
  return PEEK_IN_MIN_S + (PEEK_IN_MAX_S - PEEK_IN_MIN_S) * rand();
}

// S10 alternating peeks: jitter decorrelates but never alternates, so a cover group can stack its
// exposure windows. groupIndex = how many same-threat cover claimants are already committed nearby;
// the i-th one stays concealed one extra PEEK_OUT_S so the group's out-windows tile instead of overlap.
export const PEEK_CYCLE_NOMINAL_S = (PEEK_IN_MIN_S + PEEK_IN_MAX_S) / 2 + PEEK_OUT_S + 2 * PEEK_SLIDE_S;
export const PEEK_PHASE_OFFSET_MAX_S = 2 * PEEK_CYCLE_NOMINAL_S; // bound: two cycles of extra hiding is plenty
export function peekPhaseOffsetS(groupIndex) {
  const i = Math.floor(groupIndex);
  if (!Number.isFinite(i) || i <= 0) return 0;
  // Wrapped rather than clamped: a clamp would re-sync every bot past the bound into one shared phase.
  return (i * PEEK_OUT_S) % PEEK_PHASE_OFFSET_MAX_S;
}

// Fresh cycle: concealed at the anchor with a per-bot jittered hold. offsetS (peekPhaseOffsetS) adds
// a one-shot stagger to the FIRST hold only; the phase shift then persists and jitter rides on top.
export function createPeekCycle(rand = Math.random, offsetS = 0) {
  const offset = Number.isFinite(offsetS) && offsetS > 0 ? offsetS : 0;
  return { phase: 'in', t: 0, exposure: 0, outward: false, inHoldS: rollPeekIn(rand) + offset };
}

// Advance the cycle by dt (mutates + returns peek). exposure: 0 = anchorPos .. 1 = peekPos.
export function stepPeekCycle(peek, dt, rand = Math.random) {
  peek.t += dt;
  if (peek.phase === 'in' && peek.t >= peek.inHoldS) { peek.phase = 'sliding'; peek.outward = true; peek.t = 0; }
  else if (peek.phase === 'out' && peek.t >= PEEK_OUT_S) { peek.phase = 'sliding'; peek.outward = false; peek.t = 0; }
  if (peek.phase === 'sliding') {
    peek.exposure += (peek.outward ? dt : -dt) / PEEK_SLIDE_S;
    if (peek.outward && peek.exposure >= 1) { peek.phase = 'out'; peek.t = 0; }
    else if (!peek.outward && peek.exposure <= 0) { peek.phase = 'in'; peek.t = 0; peek.inHoldS = rollPeekIn(rand); }
    peek.exposure = Math.min(1, Math.max(0, peek.exposure));
  } else {
    peek.exposure = peek.phase === 'out' ? 1 : 0;
  }
  return peek;
}

// Where the bot should stand on the anchor->peek line for the current exposure.
export function peekPosition(peek, anchorPos, peekPos) {
  const e = peek.exposure;
  return { x: anchorPos.x + (peekPos.x - anchorPos.x) * e, z: anchorPos.z + (peekPos.z - anchorPos.z) * e };
}

// Aiming out (slide-out + fully out) vs. eligible to actually fire (fully out only).
export function peekAiming(peek) { return peek.phase === 'out' || (peek.phase === 'sliding' && peek.outward); }
export function peekExposed(peek) { return peek.phase === 'out'; }

// Clamped XZ step from current toward target — seats onto the slide line without teleport pops.
export function approachXZ(current, target, maxStep) {
  const dx = target.x - current.x, dz = target.z - current.z;
  const dist = Math.hypot(dx, dz);
  if (dist <= maxStep || dist < 1e-9) return { x: target.x, z: target.z };
  return { x: current.x + (dx / dist) * maxStep, z: current.z + (dz / dist) * maxStep };
}

// Seat band (C3): one threshold made crowded bots flap HOLD<->MOVE every few frames (pushout
// displaces ~0.3 m, reach was 0.45 m), and every flip restarted the peek cycle + drought clock.
// Enter the seat inside REACH, keep it until past LEAVE. `dist` is to the expected peek seat.
export const COVER_ANCHOR_REACH = 0.45; // m, arriving: this close to the seat counts as seated
export const COVER_ANCHOR_LEAVE = 0.9;  // m, seated: only past this does the bot read off-station
export function coverSeatBand(dist, holding) {
  return dist <= (holding ? COVER_ANCHOR_LEAVE : COVER_ANCHOR_REACH);
}

// Commit timeout (C2): measures time spent TRAVELING to the anchor, so the caller must stamp
// moveSinceMs on every entry into COVER_MOVE (incl. HOLD->MOVE), not once at corner commit.
// null moveSince = not traveling -> never timed out.
export const COVER_COMMIT_TIMEOUT_S = 6;
export function coverCommitTimedOut(moveSinceMs, nowMs) {
  return moveSinceMs != null && nowMs - moveSinceMs > COVER_COMMIT_TIMEOUT_S * 1000;
}

// Corner blacklist (C14): was a life-scoped Set, so long-lived bots exhausted every corner in
// the room and stopped using cover. Map<anchorCell, expiresAt>; reads self-prune, writes sweep.
export const COVER_BLACKLIST_TTL_MS = 20000;
export function createCoverBlacklist() { return new Map(); }
export function pruneCoverBlacklist(map, nowMs) {
  if (!map) return;
  for (const [cell, expiresAt] of map) if (nowMs >= expiresAt) map.delete(cell);
}
export function blacklistCover(map, cell, nowMs) {
  if (!map || cell == null) return;
  pruneCoverBlacklist(map, nowMs);
  map.set(cell, nowMs + COVER_BLACKLIST_TTL_MS);
}
// Alloc-free skip test; drops the entry it finds expired (safe inside a corners loop).
export function coverBlacklisted(map, cell, nowMs) {
  if (!map) return false;
  const expiresAt = map.get(cell);
  if (expiresAt == null) return false;
  if (nowMs >= expiresAt) { map.delete(cell); return false; }
  return true;
}

// Hysteresis: boundary-strafing threats flip validity per frame; debounce + rate-limit switches.
export const COVER_INVALID_GRACE_S = 0.35;  // invalid must persist this long before breaking hold
export const COVER_SWITCH_COOLDOWN_S = 0.8; // min spacing between corner commits per bot

export function coverSwitchAllowed(gate, nowMs) {
  return gate.switchedAt == null || nowMs - gate.switchedAt >= COVER_SWITCH_COOLDOWN_S * 1000;
}
export function noteCoverSwitch(gate, nowMs) { gate.switchedAt = nowMs; gate.invalidSince = null; }
// Debounce step (mutates gate): holdValid keeps the current corner; maySwitch permits one re-pick.
export function stepCoverGate(gate, rawValid, nowMs) {
  if (rawValid) { gate.invalidSince = null; return { holdValid: true, maySwitch: false }; }
  if (gate.invalidSince == null) gate.invalidSince = nowMs;
  const graceOver = nowMs - gate.invalidSince >= COVER_INVALID_GRACE_S * 1000;
  return { holdValid: !graceOver, maySwitch: graceOver && coverSwitchAllowed(gate, nowMs) };
}

// Wall-clock exit pressure: shot-driven exits (miss/blocked streaks) never fire for a bot that can't shoot.
export const COVER_FIRE_DROUGHT_S = 6;   // held without landing a single shot -> release + blacklist
export const COVER_THREAT_STALE_S = 5.5; // live threat unseen this long -> release (no blacklist), go investigate
// S8 'allyDown': a squadmate dying right next to the holder used to disturb nothing, so bots kept
// peeking at the original bearing while the fight moved. Fresh lethal report + a materially different
// bearing = the corner is aimed the wrong way; release (do NOT blacklist) and re-pick for the new one.
export const COVER_ALLY_DOWN_FRESH_S = 2;                            // older lethal reports are history, not news
export const COVER_ALLY_DOWN_BEARING_COS = Math.cos(45 * Math.PI / 180); // > ~45deg apart counts as a new bearing

// cos of the angle between two bearings, or null when either is missing/degenerate. Both points must
// share a frame: pass holderPos to turn world positions into bearings, omit it for ready-made vectors.
function bearingCos(a, b, holderPos) {
  if (!a || !b) return null;
  const ox = holderPos ? holderPos.x : 0, oz = holderPos ? holderPos.z : 0;
  const ax = a.x - ox, az = a.z - oz, bx = b.x - ox, bz = b.z - oz;
  const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
  if (la < 1e-6 || lb < 1e-6) return null;
  return (ax * bx + az * bz) / (la * lb);
}

export function coverHoldExitReason({ nowMs, holdSinceMs = null, lastShotAtMs = null,
  lastSeenAtMs = null, targetVisible = false, targetAlive = false,
  allyDownAt = null, allyDownFrom = null, heldThreat = null, holderPos = null } = {}) {
  if (targetAlive && !targetVisible && lastSeenAtMs != null &&
      nowMs - lastSeenAtMs >= COVER_THREAT_STALE_S * 1000) return 'stale';
  // Ahead of 'drought': fresh casualty intel outranks a slow no-shots clock (and must not blacklist).
  if (allyDownAt != null && nowMs - allyDownAt <= COVER_ALLY_DOWN_FRESH_S * 1000) {
    const cos = bearingCos(allyDownFrom, heldThreat, holderPos);
    if (cos != null && cos < COVER_ALLY_DOWN_BEARING_COS) return 'allyDown';
  }
  if (holdSinceMs != null &&
      nowMs - Math.max(holdSinceMs, lastShotAtMs ?? -Infinity) >= COVER_FIRE_DROUGHT_S * 1000) return 'drought';
  return null;
}

// Weapon-linked band: past standoff*factor a corner camp plinks forever; fall through to pursue.
export const COVER_RANGE_FACTOR = 1.5;
export const COVER_PEEK_MISS_LIMIT = 6; // consecutive no-target-hit peek shots before the corner is blacklisted
export function coverInBand(threatDist, standoff, committed, exitBuffer = 0) {
  return threatDist <= standoff * COVER_RANGE_FACTOR + (committed ? exitBuffer : 0);
}

// H6b secondary-threat veto: in a 2vN fight bots hid from enemy A while standing open to enemy B.
// Pure veto — it never promotes a corner, only rejects one whose ANCHOR the second shooter can see.
// Fail-open like the primary test (unknown/off-grid cell or a field that won't answer -> no veto).
function secondaryVetoes(field, navGrid, rec, secondaryThreat) {
  if (!secondaryThreat || !field || !rec) return false;
  const cell = cellIndexAt(navGrid, secondaryThreat.x, secondaryThreat.z);
  return cell != null && cell >= 0 && field.canSee(cell, rec.anchorCell) === true;
}

// Corner validity vs. a threat is two bit tests on the baked field: anchor hidden, peek exposed.
// secondaryThreat (optional) adds a third: the anchor must also be hidden from that shooter.
export function coverCornerValid({ field, navGrid }, rec, threatPos, secondaryThreat = null) {
  if (!rec || !threatPos) return false;
  const threatCell = cellIndexAt(navGrid, threatPos.x, threatPos.z);
  if (field.canSee(threatCell, rec.anchorCell) || !field.canSee(threatCell, rec.peekCell)) return false;
  return !secondaryVetoes(field, navGrid, rec, secondaryThreat);
}

// ---- flee-goal scoring (L5 route exposure + S9 squad pull) ----
// The inline harness score judged the DESTINATION only, so a cell tucked behind the shooter scored
// max even when the only route to it crossed his muzzle. Score every term in one tested place.

export const FLEE_EXPOSURE_STRIDE = 3;   // sample every k-th path cell: routes are cell-dense, LOS is not
export const FLEE_EXPOSURE_PENALTY = 10; // score lost by a fully-exposed route (~cancels FLEE_COVER_BONUS)
export const FLEE_PATH_COST = 0.2;       // per-metre travel cost, so near cover beats far cover
export const FLEE_COVER_BONUS = 12;      // endpoint hidden from the threat (harness passes its tunable)
export const FLEE_CENTROID_PULL = 0.15;  // per-metre drift from the squad centroid (S9); gentle by design

// Fraction [0,1] of sampled cells along a candidate route that `threatCell` can see. Invalid or
// unwalkable cells count as UNSEEN (fail-open, matching exposedToThreat in bot-alert.js) but still
// occupy a sample slot. Returns 0 for an empty/absent path or an unusable threat cell.
export function fleePathExposure(field, navGrid, threatCell, pathCells, stride = FLEE_EXPOSURE_STRIDE) {
  if (!field || !pathCells || threatCell == null || threatCell < 0) return 0;
  const n = pathCells.length;
  if (n === 0) return 0;
  const step = stride >= 1 ? Math.floor(stride) : 1;
  const cells = navGrid ? navGrid.cells : null;
  let sampled = 0, seen = 0;
  for (let i = 0; i < n; i += step) {
    const cell = pathCells[i];
    sampled++;
    if (cell == null || cell < 0) continue;
    if (cells && cells[cell] !== 1) continue;
    if (field.canSee(threatCell, cell) === true) seen++;
  }
  return sampled ? seen / sampled : 0;
}

// Same measure walked straight off a floodFill `parent` chain — no path array is built, so this is
// the form to use inside the per-candidate scoring loop. Sampling phase is anchored at the goal
// (the array form anchors at the path start); the two agree exactly at stride 1.
export function fleePathExposureFromParents(field, navGrid, threatCell, parent, startKey, goalKey,
  stride = FLEE_EXPOSURE_STRIDE) {
  if (!field || !parent || threatCell == null || threatCell < 0 || goalKey == null || goalKey < 0) return 0;
  const step = stride >= 1 ? Math.floor(stride) : 1;
  const cells = navGrid ? navGrid.cells : null;
  let sampled = 0, seen = 0, k = goalKey, i = 0;
  for (let guard = parent.length + 1; guard > 0; guard--) { // acyclic by construction; guard is a corrupt-data backstop
    if (i % step === 0) {
      sampled++;
      if (k >= 0 && (!cells || cells[k] === 1) && field.canSee(threatCell, k) === true) seen++;
    }
    if (k === startKey) break;
    k = parent[k];
    if (k == null || k < 0) break; // broken chain: score what was reachable rather than throwing
    i++;
  }
  return sampled ? seen / sampled : 0;
}

// The one flee-candidate scoring rule. Terms, all in score units (1 unit ~ 1 m of threat distance):
//   + threatDistance             straight-line metres from the endpoint to the threat (the payload)
//   - FLEE_PATH_COST * pathDist  flood-distance travel cost in metres
//   + coverScore   if covered    endpoint hidden from the threat (harness tunable, default 12)
//   - FLEE_EXPOSURE_PENALTY * exposure01   route exposure from fleePathExposure (L5)
//   - FLEE_CENTROID_PULL * centroidDistance   metres from the squad centroid; null/undefined = off (S9)
// Only reads its argument, so a scoring loop should hoist ONE scratch object and overwrite the
// fields each candidate (set every field explicitly then — reuse skips the destructuring defaults).
export function fleeCandidateScore({ threatDistance = 0, pathDist = 0, covered = false,
  exposure01 = 0, centroidDistance = null, coverScore = FLEE_COVER_BONUS } = {}) {
  let score = threatDistance - FLEE_PATH_COST * pathDist;
  if (covered) score += coverScore;
  score -= FLEE_EXPOSURE_PENALTY * exposure01;
  if (centroidDistance != null) score -= FLEE_CENTROID_PULL * centroidDistance;
  return score;
}

export const COVER_SECONDARY_PENALTY = 6; // score cost of an anchor a second shooter can see (soft, not a veto)

// Best corner record within searchRadius that hides botPos from threatPos, or null. Zero
// raycasts; `skip(rec)` carries caller-side vetoes (engagement blacklist, another bot's claim).
// secondaryThreat (optional, H6b) PENALIZES corners whose anchor a second shooter can see:
// half-cover still blocks one of two firing lines, and the pick-time alternative is the open.
export function pickCoverCorner({ corners, field, navGrid, searchRadius, skip }, botPos, threatPos,
  secondaryThreat = null) {
  const threatCell = cellIndexAt(navGrid, threatPos.x, threatPos.z);
  if (threatCell < 0) return null;
  // Hoisted: one cell lookup for the whole scan, and < 0 degrades to "no veto" (fail-open).
  const secondCell = secondaryThreat ? cellIndexAt(navGrid, secondaryThreat.x, secondaryThreat.z) : -1;
  const threatDist = Math.hypot(threatPos.x - botPos.x, threatPos.z - botPos.z);
  const bear = threatDist > 1e-4 ? { x: (threatPos.x - botPos.x) / threatDist, z: (threatPos.z - botPos.z) / threatDist } : null;
  let best = null, bestScore = -Infinity;
  for (const rec of corners) {
    const dist = Math.hypot(rec.anchorPos.x - botPos.x, rec.anchorPos.z - botPos.z);
    if (dist > searchRadius) continue;
    if (skip && skip(rec)) continue;
    if (field.canSee(threatCell, rec.anchorCell) || !field.canSee(threatCell, rec.peekCell)) continue;
    // Closer anchors win; running toward the threat is penalized harder than plain distance;
    // a wall face square-on to the threat (peekDir perpendicular to the bearing) peeks tighter.
    let score = -dist;
    if (secondCell >= 0 && field.canSee(secondCell, rec.anchorCell) === true) score -= COVER_SECONDARY_PENALTY;
    const anchorToThreat = Math.hypot(threatPos.x - rec.anchorPos.x, threatPos.z - rec.anchorPos.z);
    if (anchorToThreat < threatDist) score -= (threatDist - anchorToThreat) * 1.5;
    if (bear) score += (1 - Math.abs(bear.x * rec.peekDir.x + bear.z * rec.peekDir.z)) * 2;
    if (score > bestScore) { bestScore = score; best = rec; }
  }
  return best;
}
