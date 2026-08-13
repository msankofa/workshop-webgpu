// Spawn markers: the team-owned points a team's bots appear at, and the garrison they hold there.
// A base is a spawn marker with a compound built around it -- same record either way, so free-form
// clicked markers and side-mode home points go down one path. Pure math + bookkeeping, no THREE and
// no viewer globals, so bot-viewer-v3 and the environment viewer can share it.
import { teamSideRegions } from './bot-structures.js';

export const SPAWN_MARKER_DEFAULTS = {
  radius: 9,       // m, the garrison ring a squad holds around its marker
  spread: 6,       // m, how far from a marker a spawning bot may land
  pickRadius: 2.5, // m, click tolerance for hit-testing an existing marker
};

export function createSpawnMarkerStore() {
  return { markers: [], seq: 0 };
}

// `base` marks a marker a compound was built around; `origin` is 'placed' (clicked) or 'side' (auto).
export function addSpawnMarker(store, { team, x, z, radius = SPAWN_MARKER_DEFAULTS.radius, base = false, origin = 'placed' } = {}) {
  const marker = { id: `spawn-${++store.seq}`, team, x, z, radius, base, origin };
  store.markers.push(marker);
  return marker;
}

export function removeSpawnMarker(store, id) {
  const at = store.markers.findIndex((m) => m.id === id);
  if (at < 0) return null;
  return store.markers.splice(at, 1)[0];
}

// Nearest marker within `maxDist`, so a click can toggle one off instead of stacking a second on it.
export function spawnMarkerNear(store, x, z, maxDist = SPAWN_MARKER_DEFAULTS.pickRadius, team = null) {
  let best = null, bestDist = maxDist;
  for (const marker of store.markers) {
    if (team && marker.team !== team) continue;
    const dist = Math.hypot(marker.x - x, marker.z - z);
    if (dist <= bestDist) { best = marker; bestDist = dist; }
  }
  return best;
}

export function spawnMarkersForTeam(store, team) {
  return store.markers.filter((m) => m.team === team);
}

// `origin` clears only auto-created side markers (or only placed ones) and leaves the rest alone.
export function clearSpawnMarkers(store, { team = null, origin = null } = {}) {
  const kept = store.markers.filter((m) => (team && m.team !== team) || (origin && m.origin !== origin));
  const removed = store.markers.length - kept.length;
  store.markers = kept;
  return removed;
}

export function pickSpawnMarker(store, team, rng = Math.random) {
  const own = spawnMarkersForTeam(store, team);
  if (!own.length) return null;
  return own[Math.min(own.length - 1, Math.floor(rng() * own.length))];
}

// The marker a bot belongs to, by id, so a garrison survives markers being added or reordered.
export function spawnMarkerById(store, id) {
  return store.markers.find((m) => m.id === id) || null;
}

export function serializeSpawnMarkers(store) {
  return store.markers.map((m) => ({ team: m.team, x: m.x, z: m.z, radius: m.radius, base: m.base, origin: m.origin }));
}

export function loadSpawnMarkers(store, data) {
  store.markers = [];
  store.seq = 0;
  for (const entry of Array.isArray(data) ? data : []) {
    if (!entry || !Number.isFinite(entry.x) || !Number.isFinite(entry.z) || !entry.team) continue;
    addSpawnMarker(store, entry);
  }
  return store.markers.length;
}

// A compound is axis-aligned, so its gateway faces whichever axis the marker sits furthest along:
// a marker near the north edge opens south, one near the west edge opens east.
export function markerRegion(bounds, marker) {
  const midX = (bounds.minX + bounds.maxX) / 2, midZ = (bounds.minZ + bounds.maxZ) / 2;
  const offX = marker.x - midX, offZ = marker.z - midZ;
  const axis = Math.abs(offZ) >= Math.abs(offX) ? 'z' : 'x';
  const along = axis === 'z' ? offZ : offX;
  return { team: marker.team, axis, facing: along > 0 ? -1 : 1, x: marker.x, z: marker.z };
}

// Where one member of a garrisoned squad parks: rank 0 (the leader) on the marker, everyone else on
// a ring inside it. Deterministic in `index` so a bot keeps its spot instead of swapping every tick.
// `out` is an optional target, because the viewer calls this per bot per frame.
export function garrisonSlot(marker, index, count, out = { x: 0, z: 0 }) {
  if (index <= 0) { out.x = marker.x; out.z = marker.z; return out; }
  const ring = marker.radius * 0.55;
  const angle = ((index - 1) / Math.max(1, count - 1)) * Math.PI * 2;
  out.x = marker.x + Math.cos(angle) * ring;
  out.z = marker.z + Math.sin(angle) * ring;
  return out;
}

export function garrisonSlots(marker, count) {
  const slots = [];
  for (let index = 0; index < count; index++) slots.push(garrisonSlot(marker, index, count));
  return slots;
}

export function withinGarrison(marker, x, z, slack = 0) {
  return Math.hypot(marker.x - x, marker.z - z) <= marker.radius + slack;
}

// Pull a goal that left the garrison back onto its edge, so an intruder is still chased -- just not
// past the ring. Returns the goal unchanged when it is already inside.
export function clampToGarrison(marker, goal, slack = 0) {
  const dx = goal.x - marker.x, dz = goal.z - marker.z;
  const dist = Math.hypot(dx, dz);
  const limit = marker.radius + slack;
  if (dist <= limit || dist === 0) return goal;
  return { x: marker.x + (dx / dist) * limit, z: marker.z + (dz / dist) * limit };
}

// Side mode's one-per-team home points, as ordinary markers. Rebuilt on every map build, which is why
// they carry origin 'side': clearing them must not touch anything the user placed by hand.
export function sideModeMarkers(bounds, teams, { radius = SPAWN_MARKER_DEFAULTS.radius } = {}) {
  const out = [];
  for (const region of teamSideRegions(bounds, teams).values()) {
    out.push({ team: region.team, x: region.x, z: region.z, radius, base: false, origin: 'side' });
  }
  return out;
}
