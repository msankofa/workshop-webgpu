// bot-separation.js — pure, THREE-free bot-bot separation math + movement-goal claims.
// Node-tested in test-bot-separation.mjs; re-exported by bot-entity.js (which needs THREE and
// so can't itself be imported by Node tests against this repo's stripped local three install).
// Consumed by bot-viewer.html's post-step pushout, followPath steering, and goal pickers.

function shiftBotXZ(bot, dx, dz) {
  bot.capsule.start.x += dx; bot.capsule.start.z += dz;
  bot.capsule.end.x += dx; bot.capsule.end.z += dz;
}

// One O(n^2) XZ pushout pass over bot capsule pairs; caller pre-filters dead/ragdolled bots.
// Returns the Set of bots that were moved so the caller can re-resolve them against walls.
export function resolveBotPairs(bots, radius) {
  const moved = new Set();
  for (let i = 0; i < bots.length; i++) {
    const a = bots[i];
    for (let j = i + 1; j < bots.length; j++) {
      const b = bots[j];
      const minDist = (radius ?? a.capsule.radius) + (radius ?? b.capsule.radius);
      const dx = b.capsule.start.x - a.capsule.start.x;
      const dz = b.capsule.start.z - a.capsule.start.z;
      const dist = Math.hypot(dx, dz);
      if (dist >= minDist) continue;
      const push = (minDist - dist) * 0.5;
      let nx = 1, nz = 0; // coincident centers: deterministic +X split
      if (dist > 1e-6) { nx = dx / dist; nz = dz / dist; }
      shiftBotXZ(a, -nx * push, -nz * push);
      shiftBotXZ(b, nx * push, nz * push);
      moved.add(a).add(b);
    }
  }
  return moved;
}

// 1/dist-weighted XZ separation force away from living neighbors within `radius`, or null.
export function separationXZ(self, bots, radius) {
  let sx = 0, sz = 0, any = false;
  for (const other of bots) {
    if (other === self || other.alive === false) continue;
    const dx = self.capsule.start.x - other.capsule.start.x;
    const dz = self.capsule.start.z - other.capsule.start.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-6 || dist > radius) continue;
    sx += dx / (dist * dist);
    sz += dz / (dist * dist);
    any = true;
  }
  return any ? { x: sx, z: sz } : null;
}

// --- bot-spatial-hash.js-backed variants of resolveBotPairs/separationXZ/waypointContested ---
// Same semantics, neighbors drawn from a hash rebuilt over the living roster this frame. Module
// scratch + hoisted visitors keep the queries allocation-free (the hash calls fn per candidate).

let _sepSelf = null, _sepRadius = 0, _sepX = 0, _sepZ = 0, _sepAny = false;
function _sepVisit(other) {
  if (other === _sepSelf || other.alive === false) return;
  const dx = _sepSelf.capsule.start.x - other.capsule.start.x;
  const dz = _sepSelf.capsule.start.z - other.capsule.start.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-6 || dist > _sepRadius) return;
  _sepX += dx / (dist * dist);
  _sepZ += dz / (dist * dist);
  _sepAny = true;
}

// separationXZ over hashed neighbors; same contributor set, sum order may differ.
export function separationXZHashed(self, hash, radius) {
  _sepSelf = self; _sepRadius = radius; _sepX = 0; _sepZ = 0; _sepAny = false;
  hash.forEachNear(self.capsule.start.x, self.capsule.start.z, radius, _sepVisit);
  _sepSelf = null;
  return _sepAny ? { x: _sepX, z: _sepZ } : null;
}

let _wcSelf = null, _wcWp = null, _wcWpDist = 0, _wcContact = 0;
function _wcVisit(other) {
  if (other === _wcSelf || other.alive === false) return;
  const dx = other.capsule.start.x - _wcSelf.capsule.start.x;
  const dz = other.capsule.start.z - _wcSelf.capsule.start.z;
  if (Math.hypot(dx, dz) >= _wcContact) return;
  return Math.hypot(_wcWp.x - other.capsule.start.x, _wcWp.z - other.capsule.start.z) < _wcWpDist;
}

// waypointContested over hashed neighbors; the visitor's true return stops the walk early.
export function waypointContestedHashed(self, hash, waypoint, wpDist, contactDist) {
  _wcSelf = self; _wcWp = waypoint; _wcWpDist = wpDist; _wcContact = contactDist;
  const hit = hash.forEachNear(self.capsule.start.x, self.capsule.start.z, contactDist, _wcVisit);
  _wcSelf = null; _wcWp = null;
  return hit === true;
}

let _pairStamp = 0;
let _pairA = null, _pairAIdx = -1, _pairRadius = null, _pairMaxR = 0, _pairMoved = null;
function _pairVisit(b) {
  // Stamp + index are re-applied per pass, so extra entities in the hash (dead bots, props) are
  // skipped and each pair is handled exactly once -- by its lower-indexed member.
  if (b._pairStamp !== _pairStamp || b._pairIdx <= _pairAIdx) return;
  const a = _pairA;
  const minDist = (_pairRadius ?? a.capsule.radius) + (_pairRadius ?? b.capsule.radius);
  const dx = b.capsule.start.x - a.capsule.start.x;
  const dz = b.capsule.start.z - a.capsule.start.z;
  const dist = Math.hypot(dx, dz);
  if (dist >= minDist) return;
  const push = (minDist - dist) * 0.5;
  let nx = 1, nz = 0; // coincident centers: deterministic +X split
  if (dist > 1e-6) { nx = dx / dist; nz = dz / dist; }
  shiftBotXZ(a, -nx * push, -nz * push);
  shiftBotXZ(b, nx * push, nz * push);
  _pairMoved.add(a).add(b);
}

// resolveBotPairs with the broad phase served by the hash. Pair set matches the all-pairs pass;
// pair ORDER does not, so crowded piles can settle to marginally different positions.
export function resolveBotPairsHashed(bots, hash, radius) {
  const moved = new Set();
  const stamp = ++_pairStamp;
  let maxR = 0;
  for (let i = 0; i < bots.length; i++) {
    bots[i]._pairStamp = stamp; bots[i]._pairIdx = i;
    if (bots[i].capsule.radius > maxR) maxR = bots[i].capsule.radius;
  }
  _pairStamp = stamp; _pairRadius = radius ?? null; _pairMaxR = maxR; _pairMoved = moved;
  for (let i = 0; i < bots.length; i++) {
    const a = bots[i];
    _pairA = a; _pairAIdx = i;
    const queryR = (radius ?? a.capsule.radius) + (radius ?? _pairMaxR);
    hash.forEachNear(a.capsule.start.x, a.capsule.start.z, queryR, _pairVisit);
  }
  _pairA = null; _pairMoved = null;
  return moved;
}

// Separation blended into a unit path direction, then walkability-gated: if `blockedAhead(mx, mz)`
// says the blended heading leads off the nav grid, drop the separation component and steer straight
// at the waypoint (always a legal cell) -- crowds must never press a bot into a wall.
export function blendSeparationDir(dirX, dirZ, sep, weight, blockedAhead) {
  let mx = dirX + sep.x * weight, mz = dirZ + sep.z * weight;
  const norm = Math.hypot(mx, mz);
  if (norm > 1e-4) { mx /= norm; mz /= norm; } else { mx = dirX; mz = dirZ; }
  if (blockedAhead && blockedAhead(mx, mz)) { mx = dirX; mz = dirZ; }
  return { x: mx, z: mz };
}

// True when a living neighbor within `contactDist` sits nearer the waypoint than the bot does --
// the reach test would starve forever, so the caller relaxes it instead of grinding in place.
export function waypointContested(self, bots, waypoint, wpDist, contactDist) {
  for (const other of bots) {
    if (other === self || other.alive === false) continue;
    const dx = other.capsule.start.x - self.capsule.start.x;
    const dz = other.capsule.start.z - self.capsule.start.z;
    if (Math.hypot(dx, dz) >= contactDist) continue;
    if (Math.hypot(waypoint.x - other.capsule.start.x, waypoint.z - other.capsule.start.z) < wpDist) return true;
  }
  return false;
}

// Layout-scoped movement-goal claims (cellIdx -> {id, kind}) so goal pickers can skip cells
// another living bot already committed to. `kind` scopes release so e.g. a pack claim doesn't
// clobber a flee claim; claim() replaces the owner's previous claim of the same kind (replan).
// A cell holds one record, last writer wins -- so a release must only ever delete a record it
// still owns by BOTH id and kind, or one bot claiming a cell under two kinds would have its
// second claim deleted by the first kind's release.
export function createGoalClaims(isAlive = () => true) {
  const cells = new Map();
  const owners = new Map(); // id -> Map<kind, cellIdx>, secondary index so release is O(owner's claims)
  // Free the cell only if its record is still this exact (id, kind) claim.
  function dropCell(cellIdx, id, kind) {
    const c = cells.get(cellIdx);
    if (c && c.id === id && c.kind === kind) cells.delete(cellIdx);
  }
  function release(id, kind = null) {
    const kinds = owners.get(id);
    if (!kinds) return;
    if (kind == null) {
      for (const [k, cellIdx] of kinds) dropCell(cellIdx, id, k);
      owners.delete(id);
      return;
    }
    const cellIdx = kinds.get(kind);
    if (cellIdx !== undefined) {
      dropCell(cellIdx, id, kind);
      kinds.delete(kind);
      if (kinds.size === 0) owners.delete(id);
    }
  }
  return {
    claim(id, kind, cellIdx) {
      release(id, kind);
      const c = cells.get(cellIdx);
      if (c) { c.id = id; c.kind = kind; } else cells.set(cellIdx, { id, kind }); // reuse the record
      let kinds = owners.get(id);
      if (!kinds) owners.set(id, kinds = new Map());
      kinds.set(kind, cellIdx);
    },
    release,
    isClaimedByOther(cellIdx, id) {
      const c = cells.get(cellIdx);
      return !!c && c.id !== id && isAlive(c.id);
    },
    clear() { cells.clear(); owners.clear(); },
    get size() { return cells.size; },
  };
}
