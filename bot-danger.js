// bot-danger.js — pure, THREE-free team-scoped danger memory over nav-grid cell indices.
// Node-tested in test-bot-danger.mjs; consumed by bot-viewer's death/damage hooks and by the
// flee / patrol-resume / pack / cover scoring loops. Fixes H3: nothing remembered WHERE the team
// got hurt, so the corner an ally just died at was the next bot's top-scoring pick.
// A record is {weight, at}; decay is computed on read (no timers), so writes are rare and reads
// are one Map.get + one Math.pow — safe inside per-candidate scoring loops.

export const DANGER_DEATH_WEIGHT = 1.0;    // an ally died here
export const DANGER_HIT_WEIGHT = 0.35;     // an ally was hit here (survived): weaker evidence
export const DANGER_MAX_WEIGHT = 2;        // cap so a kill zone saturates instead of growing forever
export const DANGER_HALF_LIFE_MS = 25000;  // decayed weight halves every 25 s
export const DANGER_EPSILON = 0.05;        // below this a record is worthless: return 0 and drop it
export const DANGER_SPREAD_FRACTION = 0.4; // fraction of the weight painted onto caller-supplied neighbors
export const DANGER_MAX_ENTRIES = 64;      // per team; overflow evicts the least-recently-written cell

// Suggested penalty scales per read site (see docs/subsystems/bots.md); the harness may override.
export const DANGER_FLEE_SCALE = 6;        // vs. coverScore 12 / threat-distance metres
export const DANGER_PATROL_SCALE = 4;      // patrol-resume score is MINIMIZED: add, don't subtract
export const DANGER_PACK_SCALE = 3;        // in metres of effective extra distance to a pack
export const DANGER_COVER_SKIP_WEIGHT = 0.8; // corner anchors at/above this are skipped outright

export function createDangerField() { return { teams: new Map() }; }

export function clearDangerField(field) { if (field) field.teams.clear(); }

// Decayed weight of one record, clamped to [0, DANGER_MAX_WEIGHT]. Backwards clocks read as fresh.
function decayed(rec, now) {
  const dt = now - rec.at;
  if (!(dt > 0)) return Math.min(rec.weight, DANGER_MAX_WEIGHT);
  return Math.min(rec.weight * 2 ** (-dt / DANGER_HALF_LIFE_MS), DANGER_MAX_WEIGHT);
}

// Drop every record already under epsilon; runs on write only, never on the read path.
function pruneTeam(map, now) {
  for (const [cell, rec] of map) if (decayed(rec, now) < DANGER_EPSILON) map.delete(cell);
}

// Fold `weight` into `cell`, re-stamped to `now`. Re-inserting keeps Map order = write recency.
function paint(map, cell, weight, now) {
  if (cell == null || cell < 0 || !(weight > 0)) return;
  const rec = map.get(cell);
  if (rec) {
    const w = Math.min(decayed(rec, now) + weight, DANGER_MAX_WEIGHT);
    map.delete(cell);
    rec.weight = w; rec.at = now;
    map.set(cell, rec);
  } else {
    map.set(cell, { weight: Math.min(weight, DANGER_MAX_WEIGHT), at: now });
  }
}

// Record danger for `team` at `cellIdx` (an ally of that team was hurt there). `spread` is an
// optional caller-owned list of extra cell indices (e.g. the 8 neighbors) that each take
// DANGER_SPREAD_FRACTION of the weight — the module stays grid-agnostic. `spreadCount` lets a
// reused scratch buffer be passed without slicing. Prunes and enforces the cap on every call.
export function recordDanger(field, team, cellIdx, weight, now, spread = null, spreadCount = -1) {
  if (!field || team == null || cellIdx == null || cellIdx < 0 || !(weight > 0)) return;
  let map = field.teams.get(team);
  if (!map) { map = new Map(); field.teams.set(team, map); }
  pruneTeam(map, now);
  paint(map, cellIdx, weight, now);
  if (spread) {
    const n = spreadCount >= 0 ? spreadCount : spread.length;
    const share = weight * DANGER_SPREAD_FRACTION;
    for (let i = 0; i < n; i++) {
      const c = spread[i];
      if (c !== cellIdx) paint(map, c, share, now);
    }
  }
  // Overflow: evict least-recently-written first (Map preserves insertion order; paint re-inserts).
  while (map.size > DANGER_MAX_ENTRIES) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

// Decayed danger at one cell, in [0, DANGER_MAX_WEIGHT]. O(1), allocation-free, self-pruning:
// a record that has decayed under epsilon is deleted and reads as 0. Hot-loop safe.
export function dangerAt(field, team, cellIdx, now) {
  if (!field || team == null || cellIdx == null || cellIdx < 0) return 0;
  const map = field.teams.get(team);
  if (map === undefined) return 0;
  const rec = map.get(cellIdx);
  if (rec === undefined) return 0;
  const w = decayed(rec, now);
  if (w < DANGER_EPSILON) { map.delete(cellIdx); return 0; }
  return w;
}

// Penalty term for a scoring loop. Maximized scores subtract it, minimized scores add it.
export function dangerPenalty(field, team, cellIdx, now, scale) {
  const w = dangerAt(field, team, cellIdx, now);
  return w === 0 ? 0 : w * scale;
}

// Veto predicate for cover corners: a corner where the team is still actively dying is skipped
// rather than penalized, so a scarce good corner never wins on distance alone.
export function dangerBlocksCover(field, team, cellIdx, now, threshold = DANGER_COVER_SKIP_WEIGHT) {
  return dangerAt(field, team, cellIdx, now) >= threshold;
}

// Cheap hoistable guard: false = this team has no danger memory, skip the lookups entirely.
export function hasDanger(field, team) {
  const map = field?.teams.get(team);
  return map !== undefined && map.size > 0;
}

// Live record count for a team (tests/HUD); does not decay or prune.
export function dangerEntryCount(field, team) {
  return field?.teams.get(team)?.size ?? 0;
}

// Sweep every team (call occasionally, e.g. on round reset); reads already self-prune.
export function pruneDangerField(field, now) {
  if (!field) return;
  for (const [team, map] of field.teams) {
    pruneTeam(map, now);
    if (map.size === 0) field.teams.delete(team);
  }
}

// The 8 neighbors of `cellIdx` on a cols x rows grid, written into caller-owned `out`; returns
// the count. Grid-shape math only (no nav-grid import), so recordDanger stays index-based.
export function cellNeighbors8(cellIdx, cols, rows, out) {
  if (cellIdx == null || cellIdx < 0 || cols <= 0) return 0;
  const c = cellIdx % cols, r = (cellIdx - (cellIdx % cols)) / cols;
  if (r >= rows) return 0;
  let n = 0;
  for (let dr = -1; dr <= 1; dr++) {
    const rr = r + dr;
    if (rr < 0 || rr >= rows) continue;
    for (let dc = -1; dc <= 1; dc++) {
      const cc = c + dc;
      if ((dc === 0 && dr === 0) || cc < 0 || cc >= cols) continue;
      out[n++] = rr * cols + cc;
    }
  }
  return n;
}
